//! Project-scoped Hermes JSON-RPC gateway used by the SCLIP chat UI.
//!
//! The old right panel spoke to an ANSI PTY. Hermes already exposes a typed
//! WebSocket protocol with message deltas, tool lifecycle events, and reasoning
//! events; this state owns one loopback-only gateway for the open project.

use crate::hermes_runtime::{prepare_for_project, HermesRuntimeConfig};
use std::collections::HashSet;
use std::fs;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

struct GatewayProcess {
    instance_id: String,
    project_id: String,
    port: u16,
    session_token: String,
    child: Child,
    started_at_ms: u128,
}

const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1_500);
const FORCED_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(750);

/// A lease is deliberately small and contains no credentials.  It is not used
/// as the sole ownership proof: process commands and the parent chain must
/// still identify a bundled SCLIP gateway before reclamation is allowed.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLease {
    instance_id: String,
    gui_pid: u32,
    hermes_pid: u32,
    port: u16,
    project_id: String,
    started_at_ms: u128,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleGatewayCleanup {
    pub candidates: usize,
    pub terminated_hermes_pids: Vec<u32>,
    pub skipped_reason: Option<String>,
}

pub struct AgentGatewayState {
    process: Mutex<Option<GatewayProcess>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SclipAgentGateway {
    pub url: String,
}

/// Runtime-only diagnostic record. Descendant PIDs are discovered from the
/// current process tree rather than guessed from a stale PID file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SclipGatewayDiagnostic {
    pub project_id: String,
    pub gui_pid: u32,
    pub profile: String,
    pub port: u16,
    pub started_at_ms: u128,
    pub hermes_pid: u32,
    pub watchdog_pids: Vec<u32>,
    pub mcp_pids: Vec<u32>,
    pub health: &'static str,
    pub mcp_health: &'static str,
}

impl AgentGatewayState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    fn unused_loopback_port() -> Result<u16, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        listener
            .local_addr()
            .map(|address| address.port())
            .map_err(|error| error.to_string())
    }

    /// Stop only this live Child and its currently-proven descendant tree.
    /// The stdio watchdog creates a separate MCP session, so Hermes' process
    /// group alone is not a reliable ownership boundary.
    fn stop(process: &mut GatewayProcess, reason: &str) {
        let started = Instant::now();
        let hermes_pid = process.child.id();
        let mut owned: Vec<u32> = gateway_descendants(hermes_pid)
            .into_iter()
            .map(|(pid, _)| pid)
            .collect();
        owned.push(hermes_pid);
        owned.sort_unstable();
        owned.dedup();
        eprintln!("[Sclip] gateway shutdown requested instance={} reason={} gui_pid={} hermes_pid={} owned_pids={:?}", process.instance_id, reason, std::process::id(), hermes_pid, owned);
        for pid in &owned {
            unsafe {
                let _ = libc::kill(*pid as i32, libc::SIGTERM);
            }
        }
        let mut wait_for = |timeout: Duration| {
            let deadline = Instant::now() + timeout;
            loop {
                // A terminated direct child is still visible to kill(pid, 0)
                // until it is reaped, so reap opportunistically while polling.
                let direct_child_exited = process.child.try_wait().ok().flatten().is_some();
                let survivors: Vec<u32> = owned
                    .iter()
                    .copied()
                    .filter(|pid| {
                        (*pid != hermes_pid || !direct_child_exited) && process_alive(*pid)
                    })
                    .collect();
                if survivors.is_empty() || Instant::now() >= deadline {
                    return survivors;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        };
        let mut survivors = wait_for(GRACEFUL_SHUTDOWN_TIMEOUT);
        let forced_kill_used = !survivors.is_empty();
        if forced_kill_used {
            for pid in &survivors {
                unsafe {
                    let _ = libc::kill(*pid as i32, libc::SIGKILL);
                }
            }
            survivors = wait_for(FORCED_SHUTDOWN_TIMEOUT);
        }
        let _ = process.child.try_wait();
        eprintln!("[Sclip] gateway shutdown complete instance={} reason={} forced_kill_used={} remaining_pids={:?} duration_ms={}", process.instance_id, reason, forced_kill_used, survivors, started.elapsed().as_millis());
    }

    fn lease_path(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("sclip-gateway-lease.json"))
    }

    fn write_lease(app: &AppHandle, process: &GatewayProcess) {
        let Some(path) = Self::lease_path(app) else {
            return;
        };
        let Some(parent) = path.parent() else { return };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let lease = GatewayLease {
            instance_id: process.instance_id.clone(),
            gui_pid: std::process::id(),
            hermes_pid: process.child.id(),
            port: process.port,
            project_id: process.project_id.clone(),
            started_at_ms: process.started_at_ms,
        };
        if let Ok(json) = serde_json::to_vec(&lease) {
            let _ = fs::write(path, json);
        }
    }

    fn clear_lease(app: &AppHandle) {
        if let Some(path) = Self::lease_path(app) {
            let _ = fs::remove_file(path);
        }
    }

    fn launch(
        runtime: HermesRuntimeConfig,
        project_id: &str,
        port: u16,
        session_token: &str,
    ) -> Result<Child, String> {
        let mut command = Command::new(&runtime.executable);
        command
            .args(&runtime.arguments)
            .arg("serve")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(&runtime.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Keep the server scoped to this profile. Hermes otherwise routes
            // named profiles back to its machine-wide dashboard home.
            .env("HERMES_HOME", &runtime.home)
            .env("HERMES_DESKTOP", "1")
            // Hermes protects even its loopback WebSocket with an ephemeral
            // session token. Generate it in the Tauri host so only this local
            // webview receives it; omitting this was the cause of the panel's
            // misleading "agent did not start" message.
            .env("HERMES_DASHBOARD_SESSION_TOKEN", session_token)
            .env("HERMES_MCP_SERVER", "stdio")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env_remove("PYTHONHOME");
        if let Some(python_path) = runtime.python_path {
            command.env("PYTHONPATH", python_path);
        }
        // Isolate the complete Hermes → watchdog → MCP subtree. This makes
        // later group termination both reliable and scoped to SCLIP's child.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command.spawn().map_err(|error| {
            format!("Could not start the SCLIP agent for project {project_id}: {error}")
        })
    }

    fn ensure(&self, app: &AppHandle, project_id: &str) -> Result<SclipAgentGateway, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "SCLIP agent gateway lock failed".to_string())?;
        if let Some(existing) = guard.as_mut() {
            let running = existing
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
            if existing.project_id == project_id && running {
                return Ok(SclipAgentGateway {
                    url: format!(
                        "ws://127.0.0.1:{}/api/ws?token={}",
                        existing.port, existing.session_token
                    ),
                });
            }
            Self::stop(existing, "project_switch");
            *guard = None;
        }

        let runtime =
            prepare_for_project(app, crate::load_workspace_path().as_deref(), project_id)?;
        let port = Self::unused_loopback_port()?;
        let session_token = uuid::Uuid::new_v4().to_string();
        let child = Self::launch(runtime, project_id, port, &session_token)?;
        let process = GatewayProcess {
            instance_id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            port,
            session_token: session_token.clone(),
            child,
            started_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        };
        Self::write_lease(app, &process);
        *guard = Some(process);
        Ok(SclipAgentGateway {
            url: format!("ws://127.0.0.1:{port}/api/ws?token={session_token}"),
        })
    }

    fn diagnostic(&self) -> Result<Option<SclipGatewayDiagnostic>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "SCLIP agent gateway lock failed".to_string())?;
        let Some(process) = guard.as_mut() else {
            return Ok(None);
        };
        if process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            *guard = None;
            return Ok(None);
        }

        let hermes_pid = process.child.id();
        let descendants = gateway_descendants(hermes_pid);
        let watchdog_pids: Vec<u32> = descendants
            .iter()
            .filter(|(_, command)| command.contains("mcp_stdio_watchdog.py"))
            .map(|(pid, _)| *pid)
            .collect();
        let mcp_pids: Vec<u32> = descendants
            .iter()
            .filter(|(_, command)| is_sclip_mcp_command(command))
            .map(|(pid, _)| *pid)
            .collect();
        let hermes_listening = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], process.port)),
            std::time::Duration::from_millis(250),
        )
        .is_ok();
        let health = if hermes_listening {
            "AVAILABLE"
        } else {
            "DEGRADED"
        };
        let mcp_health = if mcp_pids.is_empty() {
            "DEGRADED"
        } else {
            "AVAILABLE"
        };
        Ok(Some(SclipGatewayDiagnostic {
            project_id: process.project_id.clone(),
            gui_pid: std::process::id(),
            profile: format!(
                "sclip_project_{}",
                process
                    .project_id
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .map(|c| c.to_ascii_lowercase())
                    .collect::<String>()
            ),
            port: process.port,
            started_at_ms: process.started_at_ms,
            hermes_pid,
            watchdog_pids,
            mcp_pids,
            health,
            mcp_health,
        }))
    }

    pub fn shutdown(&self, app: Option<&AppHandle>, reason: &str) -> Result<(), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "SCLIP agent gateway lock failed".to_string())?;
        if let Some(process) = guard.as_mut() {
            Self::stop(process, reason);
        }
        *guard = None;
        if let Some(app) = app {
            Self::clear_lease(app);
        }
        Ok(())
    }
}

/// Best-effort descendant discovery is for diagnostics only. Ownership and
/// termination always use the live Child process group, never these PIDs.
fn gateway_descendants(root_pid: u32) -> Vec<(u32, String)> {
    let Ok(output) = Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        return Vec::new();
    };
    let rows = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let ppid = fields.next()?.parse::<u32>().ok()?;
            let command = fields.collect::<Vec<_>>().join(" ");
            Some((pid, ppid, command))
        })
        .collect::<Vec<_>>();
    let mut parents = vec![root_pid];
    let mut descendants = Vec::new();
    while let Some(parent) = parents.pop() {
        for (pid, ppid, command) in &rows {
            if *ppid == parent
                && !descendants
                    .iter()
                    .any(|(known, _): &(u32, String)| known == pid)
            {
                parents.push(*pid);
                descendants.push((*pid, command.clone()));
            }
        }
    }
    descendants
}

fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Canonical bundle ownership for commands whose executable is the SCLIP MCP
/// binary. This deliberately validates path components/file identity rather
/// than case-folding an arbitrary command line or matching a generic name.
fn is_sclip_bundle_executable(command: &str) -> bool {
    let Some(executable) = command.split_whitespace().next() else {
        return false;
    };
    let path = PathBuf::from(executable);
    let resolved = path.canonicalize().unwrap_or(path);
    let components: Vec<String> = resolved
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();
    let has_sclip_bundle = components
        .iter()
        .any(|part| part.eq_ignore_ascii_case("SCLIP.app"));
    let macos_index = components.iter().position(|part| part == "MacOS");
    has_sclip_bundle
        && macos_index.is_some()
        && components
            .last()
            .is_some_and(|name| name.eq_ignore_ascii_case("sclip"))
}

fn is_sclip_mcp_command(command: &str) -> bool {
    command
        .split_whitespace()
        .any(|part| part == "--mcp-server")
        && is_sclip_bundle_executable(command)
}

fn is_sclip_gui_command(command: &str) -> bool {
    !command
        .split_whitespace()
        .any(|part| part == "--mcp-server")
        && is_sclip_bundle_executable(command)
}

impl Drop for AgentGatewayState {
    fn drop(&mut self) {
        // Application exit uses Tauri's explicit RunEvent handler; Drop is
        // merely a best-effort fallback and must not be the primary owner.
        let _ = self.shutdown(None, "state_drop");
    }
}

#[tauri::command]
pub fn get_sclip_agent_gateway(
    app_handle: AppHandle,
    project_id: String,
) -> Result<SclipAgentGateway, String> {
    let state: tauri::State<'_, AgentGatewayState> = app_handle.state();
    state.ensure(&app_handle, &project_id)
}

#[tauri::command]
pub fn get_sclip_agent_gateway_diagnostic(
    app_handle: AppHandle,
) -> Result<Option<SclipGatewayDiagnostic>, String> {
    let state: tauri::State<'_, AgentGatewayState> = app_handle.state();
    state.diagnostic()
}

#[tauri::command]
pub fn shutdown_sclip_agent_gateway(app_handle: AppHandle) -> Result<(), String> {
    let state: tauri::State<'_, AgentGatewayState> = app_handle.state();
    state.shutdown(Some(&app_handle), "command")
}

pub fn shutdown_sclip_agent_gateway_for_reason(
    app_handle: &AppHandle,
    reason: &str,
) -> Result<(), String> {
    let state: tauri::State<'_, AgentGatewayState> = app_handle.state();
    state.shutdown(Some(app_handle), reason)
}

#[derive(Clone)]
struct ProcessRow {
    pid: u32,
    ppid: u32,
    command: String,
}

fn process_rows() -> Vec<ProcessRow> {
    let Ok(output) = Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(ProcessRow {
                pid: fields.next()?.parse().ok()?,
                ppid: fields.next()?.parse().ok()?,
                command: fields.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

/// Reclaims only *orphaned bundled SCLIP* stacks.  Name matching is never
/// sufficient: a candidate Hermes must be launched from an app bundle, have
/// the SCLIP MCP watchdog and SCLIP `--mcp-server` in its descendant tree, and
/// there must be no live SCLIP GUI anywhere on the host.
pub fn reclaim_stale_sclip_gateways(app: &AppHandle) -> StaleGatewayCleanup {
    let rows = process_rows();
    let own_pid = std::process::id();
    let live_gui = rows
        .iter()
        .any(|row| row.pid != own_pid && is_sclip_gui_command(&row.command));
    if live_gui {
        return StaleGatewayCleanup {
            candidates: 0,
            terminated_hermes_pids: Vec::new(),
            skipped_reason: Some("LIVE_SCLIP_GUI_PRESENT".into()),
        };
    }
    let candidates: Vec<u32> = rows
        .iter()
        .filter_map(|row| {
            let bundled_hermes = row
                .command
                .contains(".app/Contents/Resources/hermes-runtime/")
                && row.command.contains("hermes_cli.main serve");
            if !bundled_hermes {
                return None;
            }
            let descendants = gateway_descendants_from_rows(row.pid, &rows);
            let watchdog = descendants
                .iter()
                .any(|(_, command)| command.contains("mcp_stdio_watchdog.py"));
            let mcp = descendants
                .iter()
                .any(|(_, command)| is_sclip_mcp_command(command));
            (watchdog && mcp).then_some(row.pid)
        })
        .collect();
    let mut terminated = Vec::new();
    for pid in &candidates {
        unsafe {
            let _ = libc::kill(*pid as i32, libc::SIGTERM);
        }
        terminated.push(*pid);
    }
    // Give watchdogs a bounded chance to exit with their parent. Escalate only
    // the already-proven Hermes roots; never use name-based pkill.
    std::thread::sleep(Duration::from_millis(350));
    let survivors: HashSet<u32> = process_rows().into_iter().map(|row| row.pid).collect();
    for pid in &candidates {
        if survivors.contains(pid) {
            unsafe {
                let _ = libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
    }
    AgentGatewayState::clear_lease(app);
    StaleGatewayCleanup {
        candidates: candidates.len(),
        terminated_hermes_pids: terminated,
        skipped_reason: None,
    }
}

fn gateway_descendants_from_rows(root_pid: u32, rows: &[ProcessRow]) -> Vec<(u32, String)> {
    let mut parents = vec![root_pid];
    let mut descendants = Vec::new();
    while let Some(parent) = parents.pop() {
        for row in rows.iter().filter(|row| row.ppid == parent) {
            if !descendants
                .iter()
                .any(|(known, _): &(u32, String)| *known == row.pid)
            {
                parents.push(row.pid);
                descendants.push((row.pid, row.command.clone()));
            }
        }
    }
    descendants
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_process(child: Child) -> GatewayProcess {
        GatewayProcess {
            instance_id: "test-instance".into(),
            project_id: "test-project".into(),
            port: 0,
            session_token: String::new(),
            child,
            started_at_ms: 0,
        }
    }

    #[test]
    fn stop_terminates_a_real_child_tree_repeatedly_without_orphans() {
        for _ in 0..20 {
            // A real shell + child validates the actual TERM/KILL ownership
            // code, rather than mocking stop or its signal path.
            let child = Command::new("sh")
                .args(["-c", "sleep 30 & wait"])
                .spawn()
                .expect("spawn child tree");
            let root = child.id();
            let mut process = test_process(child);
            AgentGatewayState::stop(&mut process, "test");
            assert!(
                !process_alive(root),
                "gateway root {root} survived shutdown"
            );
            assert!(
                gateway_descendants(root).is_empty(),
                "descendants survived shutdown"
            );
        }
    }
}
