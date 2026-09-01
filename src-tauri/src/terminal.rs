// Terminal module for spawning Hermes in a PTY
// Uses libc::openpty to create a pseudo-terminal

use crate::hermes_runtime::HermesRuntimeConfig;
use libc::{close, dup2, execvp, fork, openpty, setsid, winsize, TIOCSWINSZ};
use std::ffi::CString;
use std::os::fd::FromRawFd;
use std::os::unix::io::RawFd;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

pub struct TerminalState {
    pub master_fd: Arc<Mutex<Option<RawFd>>>,
    pub pid: Arc<Mutex<Option<i32>>>,
    pub app_handle: AppHandle,
    pub hermes_path: Arc<Mutex<String>>,
    pub hermes_args: Arc<Mutex<Vec<String>>>,
    pub hermes_pythonpath: Arc<Mutex<Option<String>>>,
    pub hermes_home: Arc<Mutex<String>>,
    pub hermes_workdir: Arc<Mutex<String>>,
    spawn_lock: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
}

impl TerminalState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            master_fd: Arc::new(Mutex::new(None)),
            pid: Arc::new(Mutex::new(None)),
            app_handle,
            hermes_path: Arc::new(Mutex::new(String::new())),
            hermes_args: Arc::new(Mutex::new(Vec::new())),
            hermes_pythonpath: Arc::new(Mutex::new(None)),
            hermes_home: Arc::new(Mutex::new(String::new())),
            hermes_workdir: Arc::new(Mutex::new(String::new())),
            spawn_lock: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn configure(&self, runtime: HermesRuntimeConfig) {
        *self.hermes_path.lock().await = runtime.executable.to_string_lossy().to_string();
        *self.hermes_args.lock().await = runtime.arguments;
        *self.hermes_pythonpath.lock().await = runtime.python_path;
        *self.hermes_home.lock().await = runtime.home.to_string_lossy().to_string();
        *self.hermes_workdir.lock().await = runtime.workdir.to_string_lossy().to_string();
    }

    pub async fn ensure_hermes(&self) -> Result<(), String> {
        let _spawn_guard = self.spawn_lock.lock().await;
        if self.pid.lock().await.is_some() {
            return Ok(());
        }

        let hermes_path = self.hermes_path.lock().await.clone();
        let hermes_args = self.hermes_args.lock().await.clone();
        let hermes_pythonpath = self.hermes_pythonpath.lock().await.clone();
        let hermes_home = self.hermes_home.lock().await.clone();
        let hermes_workdir = self.hermes_workdir.lock().await.clone();
        if hermes_path.is_empty() || hermes_home.is_empty() || hermes_workdir.is_empty() {
            return Err("SCLIP Hermes runtime is not configured".to_string());
        }

        let mut master_fd: RawFd = -1;
        let mut slave_fd: RawFd = -1;
        let mut ws = winsize {
            ws_row: 40,
            ws_col: 120,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut termios = unsafe { std::mem::zeroed::<libc::termios>() };

        unsafe {
            if openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                &mut termios,
                &mut ws,
            ) != 0
            {
                return Err("Failed to open pty".to_string());
            }
        }

        let pid = unsafe { fork() };
        if pid < 0 {
            return Err("Fork failed".to_string());
        }

        if pid == 0 {
            // Child process - Hermes
            unsafe {
                close(master_fd);
                setsid();
                dup2(slave_fd, 0); // stdin
                dup2(slave_fd, 1); // stdout
                dup2(slave_fd, 2); // stderr
                close(slave_fd);

                // Set up environment
                std::env::set_var("HERMES_HOME", &hermes_home);
                std::env::set_var("HERMES_MCP_SERVER", "stdio");
                std::env::set_var("PYTHONNOUSERSITE", "1");
                // The bundled interpreter lives inside the signed app. Keep
                // its bytecode cache out of that read-only code bundle.
                std::env::set_var("PYTHONDONTWRITEBYTECODE", "1");
                std::env::remove_var("PYTHONHOME");
                if let Some(python_path) = hermes_pythonpath {
                    std::env::set_var("PYTHONPATH", python_path);
                } else {
                    std::env::remove_var("PYTHONPATH");
                }
                std::env::set_var("TERM", "xterm-256color");

                if let Ok(workdir) = CString::new(hermes_workdir.as_str()) {
                    libc::chdir(workdir.as_ptr());
                }

                let hermes_cmd = CString::new(hermes_path.as_str()).unwrap();
                let mut launch_args = hermes_args;
                launch_args.push("chat".to_string());
                let args = launch_args
                    .iter()
                    .map(|argument| CString::new(argument.as_str()).unwrap())
                    .collect::<Vec<_>>();
                let args_ptrs: Vec<*const i8> = std::iter::once(hermes_cmd.as_ptr())
                    .chain(args.iter().map(|s| s.as_ptr()))
                    .chain(std::iter::once(std::ptr::null()))
                    .collect();

                execvp(hermes_cmd.as_ptr(), args_ptrs.as_ptr());
            }
            std::process::exit(1);
        }

        // Parent process
        unsafe {
            close(slave_fd);
        }

        // Store master_fd and pid
        *self.master_fd.lock().await = Some(master_fd);
        *self.pid.lock().await = Some(pid);

        // A reader only owns the generation it was started for. This prevents
        // a deliberate project switch from clearing or respawning the newly
        // selected project's terminal when the previous PTY reaches EOF.
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.start_pty_reader(master_fd, generation).await;

        Ok(())
    }

    async fn start_pty_reader(&self, fd: RawFd, generation: u64) {
        let app_handle = self.app_handle.clone();
        let master_fd = self.master_fd.clone();
        let pid_arc = self.pid.clone();
        let current_generation = self.generation.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let mut file = unsafe { tokio::fs::File::from_raw_fd(fd) };

            loop {
                match file.read(&mut buf).await {
                    Ok(0) => {
                        // EOF - child process exited
                        log::info!("PTY EOF - Hermes process exited");
                        break;
                    }
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]);
                        let _ = app_handle.emit("hermes-pty-output", output.to_string());
                    }
                    Err(e) => {
                        log::error!("PTY read error: {}", e);
                        break;
                    }
                }
            }

            if current_generation.load(Ordering::SeqCst) != generation {
                return;
            }

            // Child process exited - clean up invalid FD and mark for respawn
            log::info!("Cleaning up after Hermes exit");
            *master_fd.lock().await = None;
            *pid_arc.lock().await = None;

            // Emit event to frontend so it can trigger respawn
            let _ = app_handle.emit("hermes-pty-exited", ());
        });
    }

    pub async fn write_to_pty(&self, data: &str) -> Result<(), String> {
        let master_fd = *self.master_fd.lock().await;
        if let Some(fd) = master_fd {
            // Check if FD is still valid
            if fd < 0 {
                return Err("PTY not initialized (invalid fd)".to_string());
            }

            // Use a safer approach - create file from fd without taking ownership
            let mut file = unsafe { tokio::fs::File::from_raw_fd(fd) };
            let result = file.write_all(data.as_bytes()).await;
            let flush_result = file.flush().await;

            // IMPORTANT: Don't close the file - we need to keep the FD
            // Use std::mem::forget to prevent the file from closing the FD
            std::mem::forget(file);

            match result {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::Other => {
                    // Check if it's a bad file descriptor
                    if e.raw_os_error() == Some(libc::EBADF) {
                        // FD became invalid - clear it and return error to trigger respawn
                        *self.master_fd.lock().await = None;
                        *self.pid.lock().await = None;
                        return Err("PTY fd invalid (process exited)".to_string());
                    }
                    return Err(e.to_string());
                }
                Err(e) => return Err(e.to_string()),
            }

            flush_result.map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("PTY not initialized".to_string())
        }
    }

    pub async fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master_fd = *self.master_fd.lock().await;
        if let Some(fd) = master_fd {
            let ws = winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            unsafe {
                if libc::ioctl(fd, TIOCSWINSZ, &ws) != 0 {
                    return Err("Failed to resize pty".to_string());
                }
            }
            Ok(())
        } else {
            Err("PTY not initialized".to_string())
        }
    }

    pub async fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(pid) = *self.pid.lock().await {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        if let Some(fd) = *self.master_fd.lock().await {
            unsafe { close(fd) };
        }
        *self.master_fd.lock().await = None;
        *self.pid.lock().await = None;
    }

    // Respawn Hermes if it has exited
    pub async fn respawn_hermes(&self) -> Result<(), String> {
        log::info!("Respawning Hermes...");
        self.ensure_hermes().await
    }

    pub async fn switch_runtime(&self, runtime: HermesRuntimeConfig) -> Result<(), String> {
        let current_home = self.hermes_home.lock().await.clone();
        let target_home = runtime.home.to_string_lossy().to_string();
        if current_home == target_home && self.pid.lock().await.is_some() {
            return Ok(());
        }
        self.shutdown().await;
        self.configure(runtime).await;
        self.ensure_hermes().await
    }
}

#[tauri::command]
pub async fn spawn_hermes_terminal(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state: State<'_, TerminalState> = app_handle.state();
    state.ensure_hermes().await
}

#[tauri::command]
pub async fn ensure_hermes_terminal(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state: State<'_, TerminalState> = app_handle.state();
    state.ensure_hermes().await
}

#[tauri::command]
pub async fn terminal_input(app_handle: tauri::AppHandle, data: String) -> Result<(), String> {
    let state: State<'_, TerminalState> = app_handle.state();
    state.write_to_pty(&data).await
}

#[tauri::command]
pub async fn terminal_resize(
    app_handle: tauri::AppHandle,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let state: State<'_, TerminalState> = app_handle.state();
    state.resize(rows, cols).await
}

#[tauri::command]
pub async fn respawn_hermes_terminal(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state: State<'_, TerminalState> = app_handle.state();
    state.respawn_hermes().await
}

#[tauri::command]
pub async fn set_hermes_project(
    app_handle: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let runtime = crate::hermes_runtime::prepare_for_project(
        &app_handle,
        crate::load_workspace_path().as_deref(),
        &project_id,
    )?;
    let state: State<'_, TerminalState> = app_handle.state();
    state.switch_runtime(runtime).await
}

#[tauri::command]
pub fn sync_sclip_hermes_agent_settings(
    app_handle: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    crate::hermes_runtime::sync_shared_agent_configuration(&app_handle, &project_id)
}
