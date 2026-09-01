use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const SCLIP_SOUL: &str = include_str!("../resources/hermes-home/SOUL.md");
const SCLIP_VIDEO_SKILL: &str =
    include_str!("../resources/hermes-home/skills/sclip-video-editor/SKILL.md");
const SCLIP_EDITING_PLAYBOOK: &str = include_str!(
    "../resources/hermes-home/skills/sclip-video-editor/references/editing-playbook.md"
);
const SCLIP_TALKING_HEAD_DELIVERY: &str = include_str!(
    "../resources/hermes-home/skills/sclip-video-editor/references/talking-head-delivery.md"
);
const SCLIP_SKIN: &str = include_str!("../resources/hermes-home/skins/sclip.yaml");

const LEGACY_CREDENTIAL_KEYS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "GLM_API_KEY",
    "NVIDIA_API_KEY",
];

const PROJECT_PROFILE_PREFIX: &str = "sclip_project_";

#[derive(Debug, Clone)]
pub struct HermesRuntimeConfig {
    pub executable: PathBuf,
    /// Arguments that select Hermes' CLI entry point. Empty for an ordinary
    /// Hermes executable; populated when the app ships its own Python runtime.
    pub arguments: Vec<String>,
    /// The bundled source + dependency paths used only by SCLIP's Python
    /// runtime. Keeping this explicit prevents Python from importing a user's
    /// personal Hermes installation.
    pub python_path: Option<String>,
    pub home: PathBuf,
    pub workdir: PathBuf,
}

fn resolve_runtime(app: &AppHandle) -> Result<(PathBuf, Vec<String>, Option<String>), String> {
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("SCLIP_HERMES_PATH") {
        candidates.push((PathBuf::from(path), Vec::new(), None));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let runtime = resource_dir.join("hermes-runtime");
        let python = runtime.join("python/bin/python3.11");
        let source = runtime.join("source");
        let site_packages = runtime.join("venv/lib/python3.11/site-packages");
        if python.is_file() && source.join("hermes_cli/main.py").is_file() && site_packages.is_dir()
        {
            let python_path = std::env::join_paths([source, site_packages])
                .map_err(|error| format!("Failed to prepare bundled Hermes paths: {error}"))?
                .to_string_lossy()
                .to_string();
            return Ok((
                python,
                vec!["-m".to_string(), "hermes_cli.main".to_string()],
                Some(python_path),
            ));
        }

        // Supports a future compact native Hermes distribution without
        // changing SCLIP's profile or its public terminal interface.
        candidates.push((runtime.join("bin/hermes"), Vec::new(), None));
    }

    // Development checkout: SCLIP/freecut/src-tauri -> SCLIP/hermes-agent-src.
    // This path is compiled from the checkout location and is never a fallback
    // to the user's personal ~/.hermes installation.
    candidates.push((
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hermes-agent-src/.venv/bin/hermes"),
        Vec::new(),
        None,
    ));

    for (candidate, arguments, python_path) in &candidates {
        if candidate.is_file() {
            let executable = candidate
                .canonicalize()
                .map_err(|error| format!("Failed to resolve Hermes runtime: {error}"))?;
            return Ok((executable, arguments.clone(), python_path.clone()));
        }
    }

    let searched = candidates
        .iter()
        .map(|(path, _, _)| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "SCLIP's isolated Hermes runtime was not found. Searched: {searched}"
    ))
}

/// The SCLIP editing skill is app-owned (unlike user-installed Hermes skills),
/// so ship corrections to it with each SCLIP update. This never touches other
/// skills, memory, config, sessions, or credentials in the isolated profile.
fn write_sclip_video_skill(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if path.exists() {
        let existing = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let is_sclip_owned =
            existing.contains("author: SCLIP") && existing.contains("# SCLIP Video Editor Skill");
        if !is_sclip_owned {
            // Respect a user-replaced skill rather than overwriting it.
            return Ok(());
        }
    }

    fs::write(path, contents).map_err(|error| error.to_string())
}

/// Branding is app-owned just like the SCLIP editing skill. It is installed
/// only inside SCLIP's isolated Hermes home, so a user's personal Hermes
/// identity, skin, and configuration remain untouched.
fn write_sclip_skin(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

/// Refresh only the files SCLIP owns in a Hermes profile. Project profiles
/// retain their conversations, memories, credentials, and provider choices;
/// a user-replaced video skill is also preserved by write_sclip_video_skill.
fn sync_sclip_owned_profile_assets(home: &Path) -> Result<(), String> {
    fs::write(home.join("SOUL.md"), SCLIP_SOUL).map_err(|error| error.to_string())?;
    write_sclip_video_skill(
        &home.join("skills/sclip-video-editor/SKILL.md"),
        SCLIP_VIDEO_SKILL,
    )?;
    write_sclip_skin(
        &home.join("skills/sclip-video-editor/references/editing-playbook.md"),
        SCLIP_EDITING_PLAYBOOK,
    )?;
    write_sclip_skin(
        &home.join("skills/sclip-video-editor/references/talking-head-delivery.md"),
        SCLIP_TALKING_HEAD_DELIVERY,
    )?;
    write_sclip_skin(&home.join("skins/sclip.yaml"), SCLIP_SKIN)
}

fn enforce_sclip_skin(config_path: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    // Hermes normalizes its config to YAML after the first run. The SCLIP
    // bootstrap initially writes JSON (which is YAML-compatible), so support
    // both shapes without adding a second config parser to the desktop host.
    if let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&contents) {
        let root = config
            .as_object_mut()
            .ok_or("SCLIP Hermes config must be an object")?;
        let display = root.entry("display").or_insert_with(|| json!({}));
        let display = display
            .as_object_mut()
            .ok_or("SCLIP Hermes display config must be an object")?;
        if display.get("skin").and_then(|value| value.as_str()) != Some("sclip") {
            display.insert("skin".to_string(), json!("sclip"));
            let serialized =
                serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
            fs::write(config_path, serialized).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    if !contents.lines().any(|line| line.trim() == "display:") {
        let suffix = if contents.ends_with('\n') { "" } else { "\n" };
        fs::write(
            config_path,
            format!("{contents}{suffix}display:\n  skin: sclip\n"),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_legacy_credentials(home: &Path) -> Result<(), String> {
    let destination = home.join(".env");
    if destination.exists() {
        return Ok(());
    }

    let Some(user_home) = dirs::home_dir() else {
        return Ok(());
    };
    let legacy = user_home.join(".hermes/profiles/sclip/.env");
    let Ok(contents) = fs::read_to_string(legacy) else {
        return Ok(());
    };

    let allowed = LEGACY_CREDENTIAL_KEYS
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let migrated = contents
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (key, _) = trimmed.split_once('=')?;
            allowed.contains(key.trim()).then_some(trimmed)
        })
        .collect::<Vec<_>>();

    if migrated.is_empty() {
        return Ok(());
    }

    let mut output = migrated.join("\n");
    output.push('\n');
    fs::write(&destination, output).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if source_path.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Move the isolated SCLIP profile off the legacy FreeCut bundle identifier
/// without touching a user's personal Hermes profile. The old copy is retained
/// until the user chooses to remove it, making this migration recoverable.
fn migrate_legacy_sclip_home(home: &Path) -> Result<(), String> {
    if home.exists() {
        return Ok(());
    }
    let Some(user_home) = dirs::home_dir() else {
        return Ok(());
    };
    let legacy_home = user_home.join("Library/Application Support/com.freecut.desktop/hermes");
    if legacy_home.is_dir() {
        copy_directory(&legacy_home, home)?;
    }
    Ok(())
}

fn sclip_mcp_server_config(mcp_executable: &Path) -> serde_json::Value {
    json!({
        "sclip-editor": {
            "command": mcp_executable,
            "args": ["--mcp-server"],
            "enabled": true
        }
    })
}

/// The SCLIP profile used to preserve its initial MCP executable forever. That
/// left upgrades pointing at a removed `FreeCut.app`, so the agent fell back to
/// shell exploration instead of receiving real editor tools. Refresh only this
/// app-owned MCP block while leaving model, credentials, memory, and all other
/// user configuration intact.
fn refresh_sclip_mcp_config(config_path: &Path, mcp_executable: &Path) -> Result<bool, String> {
    let contents = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    let had_legacy_reference = contents.contains("sclip-freecut")
        || contents.contains("FreeCut.app")
        || contents.contains("com.freecut.desktop");

    if let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&contents) {
        let root = config
            .as_object_mut()
            .ok_or("SCLIP Hermes config must be an object")?;
        root.insert(
            "mcp_servers".to_string(),
            sclip_mcp_server_config(mcp_executable),
        );
        let serialized =
            serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
        fs::write(config_path, serialized).map_err(|error| error.to_string())?;
        return Ok(had_legacy_reference);
    }

    // Hermes normalizes the initially generated JSON config to YAML. Replace
    // only the top-level MCP section; all other YAML remains exactly as the
    // user configured it.
    let mut retained = Vec::new();
    let mut skipping_mcp_section = false;
    for line in contents.lines() {
        let is_top_level = !line.starts_with(' ') && !line.starts_with('\t');
        if !skipping_mcp_section && is_top_level && line.trim() == "mcp_servers:" {
            skipping_mcp_section = true;
            continue;
        }
        if skipping_mcp_section {
            if is_top_level && !line.trim().is_empty() {
                skipping_mcp_section = false;
            } else {
                continue;
            }
        }
        retained.push(line);
    }

    let command = serde_json::to_string(&mcp_executable.to_string_lossy().to_string())
        .map_err(|error| error.to_string())?;
    let mcp_section = format!(
        "mcp_servers:\n  sclip-editor:\n    command: {command}\n    args:\n      - --mcp-server\n    enabled: true\n"
    );
    let body = retained.join("\n");
    fs::write(config_path, format!("{mcp_section}{body}\n")).map_err(|error| error.to_string())?;
    Ok(had_legacy_reference)
}

fn bootstrap_home(home: &Path, mcp_executable: &Path, workdir: &Path) -> Result<(), String> {
    fs::create_dir_all(home).map_err(|error| error.to_string())?;

    let config_path = home.join("config.yaml");
    if !config_path.exists() {
        // JSON is valid YAML. Generating this structure avoids quoting bugs in
        // executable/workspace paths while keeping Hermes' normal config file.
        let config = json!({
            "model": {
                "default": "poolside/laguna-s-2.1:free",
                "provider": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "api_mode": "chat_completions"
            },
            "agent": {
                "max_turns": 90,
                "reasoning_effort": "medium"
            },
            "terminal": {
                "backend": "local",
                "cwd": workdir
            },
            "memory": {
                "memory_enabled": true,
                "user_profile_enabled": true,
                "write_approval": false
            },
            "plugins": {
                "enabled": [],
                "disabled": ["sclip"]
            },
            "mcp_servers": sclip_mcp_server_config(mcp_executable)
        });
        let serialized =
            serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
        fs::write(&config_path, serialized).map_err(|error| error.to_string())?;
    }

    // The managed assets are updated independently from all user-owned
    // profile state on every bootstrap.
    sync_sclip_owned_profile_assets(home)?;

    if refresh_sclip_mcp_config(&config_path, mcp_executable)? {
        // The schema cache is keyed by the old server name/path. Removing only
        // that generated cache forces Hermes to discover the current SCLIP
        // tools on the next session instead of silently using stale metadata.
        let _ = fs::remove_file(home.join("cache/mcp_schema_cache.json"));
    }

    // Set the app-owned profile's terminal skin after Hermes has normalized
    // its config format. This never reads or changes personal Hermes config.
    enforce_sclip_skin(&config_path)?;
    migrate_legacy_credentials(home)
}

fn project_profile_name(project_id: &str) -> Result<String, String> {
    let compact = project_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    if compact.len() < 8 {
        return Err("A valid SCLIP project id is required for the project agent".to_string());
    }
    Ok(format!("{PROJECT_PROFILE_PREFIX}{compact}"))
}

fn each_project_home(
    root_home: &Path,
    mut action: impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let profiles = root_home.join("profiles");
    if !profiles.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(profiles).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if path.is_dir() && name.starts_with(PROJECT_PROFILE_PREFIX) {
            action(&path)?;
        }
    }
    Ok(())
}

/// Hermes owns model/provider configuration. Once Hermes has saved a changed
/// configuration for the active project, mirror only that configuration and
/// credential file to SCLIP's other project profiles. Conversation databases,
/// agent memories, and project chat history are never copied.
pub fn sync_shared_agent_configuration(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let workspace = crate::load_workspace_path();
    let root_runtime = prepare(app, workspace.as_deref())?;
    let project_runtime = prepare_for_project(app, workspace.as_deref(), project_id)?;
    let source_config = project_runtime.home.join("config.yaml");
    let source_env = project_runtime.home.join(".env");

    if !source_config.is_file() {
        return Err("Hermes did not create a model configuration for this project".to_string());
    }

    let copy_settings = |destination_home: &Path| -> Result<(), String> {
        if destination_home == project_runtime.home {
            return Ok(());
        }
        fs::copy(&source_config, destination_home.join("config.yaml"))
            .map_err(|error| error.to_string())?;
        if source_env.is_file() {
            let destination_env = destination_home.join(".env");
            fs::copy(&source_env, &destination_env).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(destination_env, fs::Permissions::from_mode(0o600))
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    };

    copy_settings(&root_runtime.home)?;
    each_project_home(&root_runtime.home, copy_settings)
}

/// Every edit project gets its own Hermes profile. The profile owns its
/// conversation/session history and ordinary agent memory; the app-level
/// SCLIP editing-memory store remains the explicit cross-project preference
/// layer. Credentials and the selected provider/model are copied only when a
/// project profile is first created, so chats never bleed between projects.
fn bootstrap_project_home(
    root_home: &Path,
    project_home: &Path,
    mcp_executable: &Path,
    workdir: &Path,
) -> Result<(), String> {
    if !project_home.exists() {
        fs::create_dir_all(project_home).map_err(|error| error.to_string())?;
        let source_config = root_home.join("config.yaml");
        if source_config.is_file() {
            fs::copy(&source_config, project_home.join("config.yaml"))
                .map_err(|error| error.to_string())?;
        }
        let source_env = root_home.join(".env");
        if source_env.is_file() {
            fs::copy(&source_env, project_home.join(".env")).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(project_home.join(".env"), fs::Permissions::from_mode(0o600))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    bootstrap_home(project_home, mcp_executable, workdir)
}

pub fn prepare(
    app: &AppHandle,
    workspace_path: Option<&str>,
) -> Result<HermesRuntimeConfig, String> {
    let (executable, arguments, python_path) = resolve_runtime(app)?;
    let custom_home = std::env::var_os("SCLIP_HERMES_HOME");
    let home = if let Some(path) = custom_home {
        PathBuf::from(path)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("hermes")
    };

    if std::env::var_os("SCLIP_HERMES_HOME").is_none() {
        migrate_legacy_sclip_home(&home)?;
    }

    let workdir = workspace_path
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| home.clone());
    let mcp_executable = std::env::current_exe().map_err(|error| error.to_string())?;

    bootstrap_home(&home, &mcp_executable, &workdir)?;
    // Existing projects do not necessarily open during an app upgrade. Keep
    // their managed editorial skill current now without touching their
    // conversations, configuration, credentials, or ordinary memories.
    each_project_home(&home, sync_sclip_owned_profile_assets)?;

    Ok(HermesRuntimeConfig {
        executable,
        arguments,
        python_path,
        home,
        workdir,
    })
}

pub fn prepare_for_project(
    app: &AppHandle,
    workspace_path: Option<&str>,
    project_id: &str,
) -> Result<HermesRuntimeConfig, String> {
    let base = prepare(app, workspace_path)?;
    let profile_name = project_profile_name(project_id)?;
    let project_home = base.home.join("profiles").join(profile_name);
    let mcp_executable = std::env::current_exe().map_err(|error| error.to_string())?;
    bootstrap_project_home(&base.home, &project_home, &mcp_executable, &base.workdir)?;

    Ok(HermesRuntimeConfig {
        home: project_home,
        ..base
    })
}
