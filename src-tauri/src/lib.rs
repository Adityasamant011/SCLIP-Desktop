pub mod agent_gateway;
pub mod editing_memory;
pub mod hermes_runtime;
pub mod mcp_server;
pub mod terminal;

use dirs;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const WORKSPACE_PATH_FILE: &str = "freecut_workspace_path.txt";

fn get_workspace_path_file() -> PathBuf {
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("FreeCut");
    fs::create_dir_all(&path).ok();
    path.push(WORKSPACE_PATH_FILE);
    path
}

fn save_workspace_path(path: &str) -> Result<(), String> {
    let file = get_workspace_path_file();
    fs::write(&file, path).map_err(|e| e.to_string())
}

fn load_workspace_path() -> Option<String> {
    let file = get_workspace_path_file();
    fs::read_to_string(&file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
async fn get_workspace_path() -> Result<Option<String>, String> {
    Ok(load_workspace_path())
}

#[tauri::command]
async fn pick_workspace(app: tauri::AppHandle) -> Result<String, String> {
    // Check if we already have a saved workspace path
    if let Some(saved_path) = load_workspace_path() {
        return Ok(saved_path);
    }

    // Use the native file dialog to pick a workspace directory
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Select SCLIP Workspace Folder")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()).unwrap_or_default());
        });

    let path = rx.await.unwrap_or_default();
    if !path.is_empty() {
        let _ = save_workspace_path(&path);
    }
    Ok(path)
}

/// Open the native desktop picker for media import. WebKit does not implement
/// the browser File System Access API, so the webview uses this dialog and
/// converts the returned paths into Tauri-backed file handles.
#[tauri::command]
async fn pick_media_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import media")
        .pick_files(move |files| {
            let paths = files
                .unwrap_or_default()
                .into_iter()
                .map(|path| path.to_string())
                .collect();
            let _ = tx.send(paths);
        });

    rx.await
        .map_err(|_| "Media picker was closed unexpectedly".to_string())
}

// Filesystem commands for Tauri polyfill
#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
async fn path_is_dir(path: String) -> Result<bool, String> {
    Ok(fs::metadata(&path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false))
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let path = entry.path();
            let is_dir = path.is_dir();
            DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir,
            }
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_dir(path: String, recursive: bool) -> Result<(), String> {
    if recursive {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_dir(&path).map_err(|e| e.to_string())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// Run only the MCP server (no GUI) for stdio transport
pub fn run_mcp_server_only() {
    // SILENT: no output to stdout (used for JSON-RPC)
    // Logging goes to stderr via env_logger in start_mcp_server_standalone
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create Tokio runtime");

    runtime.block_on(async {
        if let Err(e) = mcp_server::start_mcp_server_standalone().await {
            eprintln!("[Sclip] Failed to start MCP server: {}", e);
            std::process::exit(1);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            get_workspace_path,
            pick_media_files,
            path_exists,
            path_is_dir,
            list_dir,
            create_dir,
            read_file_bytes,
            write_file,
            remove_file,
            remove_dir,
            editing_memory::sclip_editing_memory,
            editing_memory::sclip_project_snapshot,
            editing_memory::sclip_rough_cut_proposal,
            editing_memory::sclip_edit_plan,
            editing_memory::sclip_correction_event,
            editing_memory::sclip_agent_audit,
            mcp_server::handle_tool_result,
            terminal::spawn_hermes_terminal,
            terminal::ensure_hermes_terminal,
            terminal::terminal_input,
            terminal::terminal_resize,
            terminal::respawn_hermes_terminal,
            terminal::set_hermes_project,
            terminal::sync_sclip_hermes_agent_settings,
            agent_gateway::get_sclip_agent_gateway,
            agent_gateway::get_sclip_agent_gateway_diagnostic,
            agent_gateway::shutdown_sclip_agent_gateway,
        ])
        // This delegates to the same idempotent owner used by app exit.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && window.label() == "main"
            {
                let _ = agent_gateway::shutdown_sclip_agent_gateway_for_reason(
                    &window.app_handle(),
                    "main_window_close",
                );
            }
        })
        .setup(|app| {
            // Manage TerminalState. Runtime/home configuration is owned by
            // SCLIP's backend; the webview cannot inject personal Hermes paths.
            let app_handle = app.handle().clone();
            // Old SCLIP versions had no durable ownership metadata and could
            // leave Hermes → watchdog → MCP trees after a crash. Reclaim only
            // stacks whose bundled paths and complete descendant shape prove
            // SCLIP ownership; unrelated Hermes/Python/MCP processes are never
            // considered.
            let cleanup = agent_gateway::reclaim_stale_sclip_gateways(&app_handle);
            if cleanup.candidates > 0 || cleanup.skipped_reason.is_some() {
                eprintln!(
                    "[Sclip] stale gateway cleanup: candidates={}, terminated={:?}, skipped={:?}",
                    cleanup.candidates, cleanup.terminated_hermes_pids, cleanup.skipped_reason
                );
            }
            app.manage(terminal::TerminalState::new(app_handle.clone()));
            app.manage(agent_gateway::AgentGatewayState::new());

            // Start the Unix socket MCP bridge (must start before Hermes)
            // This listens on /tmp/sclip-freecut-mcp.sock for tool calls from freecut --mcp-server
            let app_handle_for_socket = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp_server::start_mcp_socket_server(app_handle_for_socket).await {
                    eprintln!("[Sclip] Failed to start MCP socket server: {}", e);
                }
            });

            // Start Hermes in PTY
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let terminal_state: tauri::State<'_, terminal::TerminalState> = app_handle.state();
                let runtime =
                    match hermes_runtime::prepare(&app_handle, load_workspace_path().as_deref()) {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            eprintln!("[Sclip] Failed to prepare isolated Hermes runtime: {error}");
                            return;
                        }
                    };
                terminal_state.configure(runtime).await;
                // Hermes starts when an editor project identifies its dedicated
                // project profile. Starting a global session here leaked chat
                // history across unrelated SCLIP projects.
            });

            // Set window title
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("SCLIP");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    // Cmd+Q and the macOS Quit menu are application lifecycle events. They do
    // not reliably emit a main-window CloseRequested event.
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let reason = if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                "app_exit_requested"
            } else {
                "app_exit"
            };
            let _ = agent_gateway::shutdown_sclip_agent_gateway_for_reason(app_handle, reason);
        }
    });
}
