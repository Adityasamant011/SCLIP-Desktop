//! Structured, SCLIP-owned editing preferences.
//!
//! Hermes keeps its normal conversational/user-profile memory in the isolated
//! SCLIP Hermes home. This companion file makes editing preferences explicit,
//! inspectable, and safe to apply to a project without touching a user's
//! personal Hermes profile.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditingMemory {
    version: u8,
    updated_at: u64,
    /// Global preferences deliberately use named fields, never opaque prompts.
    preferences: Map<String, Value>,
    /// Project-specific notes such as explicit feedback or a client brief.
    projects: BTreeMap<String, Map<String, Value>>,
    feedback: Vec<FeedbackEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackEntry {
    project_id: Option<String>,
    feedback: String,
    timestamp: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotArchive {
    version: u8,
    projects: BTreeMap<String, Vec<SnapshotEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    id: String,
    label: String,
    created_at: u64,
    project: Value,
}

/// A reviewable agent proposal. Unlike a snapshot, this intentionally contains
/// no project copy: it is a compact, structured plan tied to the precise script
/// revision the agent read. The webview validates it again before application.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoughCutProposalArchive {
    version: u8,
    projects: BTreeMap<String, Vec<RoughCutProposalEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoughCutProposalEntry {
    id: String,
    created_at: u64,
    proposal: Value,
}

/// A general, evidence-grounded SCLIP plan. Hermes creates these; FreeCut
/// remains the only component that applies the individual operations.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditPlanArchive {
    version: u8,
    projects: BTreeMap<String, Vec<EditPlanEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditPlanEntry {
    id: String,
    created_at: u64,
    plan: Value,
}

/// Structured creator corrections improve later proposals without putting
/// opaque conversational text into SCLIP's editing profile.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorrectionArchive {
    version: u8,
    events: Vec<CorrectionEvent>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorrectionEvent {
    id: String,
    project_id: String,
    plan_id: Option<String>,
    operation_id: Option<String>,
    outcome: String,
    correction: Value,
    timestamp: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAudit {
    version: u8,
    entries: Vec<AgentAuditEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAuditEntry {
    call_id: String,
    tool: String,
    project_id: Option<String>,
    phase: String,
    detail: Option<String>,
    timestamp: u64,
}

fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/editing-memory.json"))
}

fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/project-snapshots.json"))
}

fn audit_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/agent-audit.json"))
}

fn rough_cut_proposal_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/rough-cut-proposals.json"))
}

/// Early SCLIP builds stored editor-owned data under a `hermes/` directory.
/// Hermes still owns the agent runtime, but SCLIP owns these structured editor
/// records. Move them once, atomically enough for a local single-process app,
/// while retaining the legacy copy as recovery until an explicit cleanup.
fn migrate_legacy_sclip_record(
    app: &AppHandle,
    destination: &PathBuf,
    legacy_name: &str,
) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("hermes")
        .join(legacy_name);
    if !legacy.exists() {
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or("SCLIP data path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::copy(legacy, destination).map_err(|error| error.to_string())?;
    Ok(())
}

fn edit_plan_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/edit-plans.json"))
}

fn correction_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sclip/correction-events.json"))
}

fn load_memory(app: &AppHandle) -> Result<EditingMemory, String> {
    let path = memory_path(app)?;
    migrate_legacy_sclip_record(app, &path, "editing-memory.json")?;
    if !path.exists() {
        return Ok(EditingMemory {
            version: 1,
            ..EditingMemory::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid SCLIP editing memory: {error}"))
}

fn save_memory(app: &AppHandle, memory: &EditingMemory) -> Result<(), String> {
    let path = memory_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP editing memory has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(memory).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_snapshots(app: &AppHandle) -> Result<SnapshotArchive, String> {
    let path = snapshot_path(app)?;
    migrate_legacy_sclip_record(app, &path, "project-snapshots.json")?;
    if !path.exists() {
        return Ok(SnapshotArchive {
            version: 1,
            ..SnapshotArchive::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid SCLIP snapshot archive: {error}"))
}

fn save_snapshots(app: &AppHandle, archive: &SnapshotArchive) -> Result<(), String> {
    let path = snapshot_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP snapshot archive has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(archive).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_rough_cut_proposals(app: &AppHandle) -> Result<RoughCutProposalArchive, String> {
    let path = rough_cut_proposal_path(app)?;
    migrate_legacy_sclip_record(app, &path, "rough-cut-proposals.json")?;
    if !path.exists() {
        return Ok(RoughCutProposalArchive {
            version: 1,
            ..RoughCutProposalArchive::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid SCLIP rough-cut proposal archive: {error}"))
}

fn save_rough_cut_proposals(
    app: &AppHandle,
    archive: &RoughCutProposalArchive,
) -> Result<(), String> {
    let path = rough_cut_proposal_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP rough-cut proposal archive has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(archive).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_edit_plans(app: &AppHandle) -> Result<EditPlanArchive, String> {
    let path = edit_plan_path(app)?;
    if !path.exists() {
        return Ok(EditPlanArchive {
            version: 1,
            ..EditPlanArchive::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid SCLIP edit-plan archive: {error}"))
}

fn save_edit_plans(app: &AppHandle, archive: &EditPlanArchive) -> Result<(), String> {
    let path = edit_plan_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP edit-plan archive has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(archive).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_corrections(app: &AppHandle) -> Result<CorrectionArchive, String> {
    let path = correction_path(app)?;
    if !path.exists() {
        return Ok(CorrectionArchive {
            version: 1,
            ..CorrectionArchive::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid SCLIP correction archive: {error}"))
}

fn save_corrections(app: &AppHandle, archive: &CorrectionArchive) -> Result<(), String> {
    let path = correction_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP correction archive has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(archive).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_audit(app: &AppHandle) -> Result<AgentAudit, String> {
    let path = audit_path(app)?;
    migrate_legacy_sclip_record(app, &path, "agent-audit.json")?;
    if !path.exists() {
        return Ok(AgentAudit {
            version: 1,
            ..AgentAudit::default()
        });
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| format!("Invalid SCLIP agent audit: {error}"))
}

fn save_audit(app: &AppHandle, audit: &AgentAudit) -> Result<(), String> {
    let path = audit_path(app)?;
    let parent = path
        .parent()
        .ok_or("SCLIP agent audit has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(audit).map_err(|error| error.to_string())?;
    fs::write(&temporary, serialized).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Editing memory is intentionally not a credential store. Hermes owns
/// provider credentials in its isolated credential flow; this rejects the
/// common accidental secret fields before any SCLIP profile/correction is
/// written to disk.
fn validate_sclip_structured_value(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(values) => {
            for (key, nested) in values {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if normalized.contains("apikey")
                    || normalized.contains("secret")
                    || normalized.contains("password")
                    || normalized.contains("accesstoken")
                    || normalized == "token"
                {
                    return Err(format!(
                        "SCLIP editing memory must not contain credential field '{key}'"
                    ));
                }
                validate_sclip_structured_value(nested)?;
            }
        }
        Value::Array(values) => {
            for nested in values {
                validate_sclip_structured_value(nested)?;
            }
        }
        Value::String(text) if text.len() > 8_000 => {
            return Err(
                "SCLIP editing memory values must be 8,000 characters or shorter".to_string(),
            );
        }
        _ => {}
    }
    Ok(())
}

/// Read or update structured editing preferences owned by SCLIP alone.
/// Actions: `get`, `update_preferences`, `set_project_context`, `record_feedback`.
#[tauri::command]
pub async fn sclip_editing_memory(
    app: AppHandle,
    action: String,
    project_id: Option<String>,
    values: Option<Map<String, Value>>,
    feedback: Option<String>,
) -> Result<Value, String> {
    let mut memory = load_memory(&app)?;
    memory.version = 1;

    match action.as_str() {
        "get" => Ok(serde_json::json!({
            "version": memory.version,
            "preferences": memory.preferences,
            "projectContext": project_id.as_ref().and_then(|id| memory.projects.get(id)),
            "recentFeedback": memory.feedback.iter().rev().take(10).collect::<Vec<_>>(),
        })),
        "update_preferences" => {
            let values = values.ok_or("values are required for update_preferences")?;
            validate_sclip_structured_value(&Value::Object(values.clone()))?;
            memory.preferences.extend(values);
            memory.updated_at = now_millis();
            save_memory(&app, &memory)?;
            Ok(serde_json::json!({ "success": true, "preferences": memory.preferences }))
        }
        "set_project_context" => {
            let project_id = project_id.ok_or("project_id is required for set_project_context")?;
            let values = values.ok_or("values are required for set_project_context")?;
            validate_sclip_structured_value(&Value::Object(values.clone()))?;
            memory
                .projects
                .entry(project_id)
                .or_default()
                .extend(values);
            memory.updated_at = now_millis();
            save_memory(&app, &memory)?;
            Ok(serde_json::json!({ "success": true }))
        }
        "record_feedback" => {
            let feedback = feedback
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .ok_or("feedback is required for record_feedback")?;
            memory.feedback.push(FeedbackEntry {
                project_id,
                feedback,
                timestamp: now_millis(),
            });
            // Avoid unbounded profile growth while keeping enough history for
            // Hermes to synthesize durable preferences into its own memory.
            if memory.feedback.len() > 200 {
                let keep_from = memory.feedback.len() - 200;
                memory.feedback.drain(0..keep_from);
            }
            memory.updated_at = now_millis();
            save_memory(&app, &memory)?;
            Ok(serde_json::json!({ "success": true, "feedbackCount": memory.feedback.len() }))
        }
        _ => Err(
            "action must be get, update_preferences, set_project_context, or record_feedback"
                .to_string(),
        ),
    }
}

/// Persistent project versions for agent recovery. The browser layer supplies
/// the real saved FreeCut Project object; this backend only archives it in the
/// isolated SCLIP profile and never modifies a workspace by itself.
#[tauri::command]
pub async fn sclip_project_snapshot(
    app: AppHandle,
    action: String,
    project_id: String,
    label: Option<String>,
    snapshot_id: Option<String>,
    project: Option<Value>,
) -> Result<Value, String> {
    let mut archive = load_snapshots(&app)?;
    archive.version = 1;
    let entries = archive.projects.entry(project_id.clone()).or_default();

    match action.as_str() {
        "create" => {
            let project = project.ok_or("project is required to create a snapshot")?;
            let entry = SnapshotEntry {
                id: uuid::Uuid::new_v4().to_string(),
                label: label.unwrap_or_else(|| "Before agent edit".to_string()),
                created_at: now_millis(),
                project,
            };
            entries.push(entry);
            if entries.len() > 50 {
                let keep_from = entries.len() - 50;
                entries.drain(0..keep_from);
            }
            let saved = entries.last().expect("snapshot was pushed");
            let response = serde_json::json!({ "success": true, "snapshot": { "id": saved.id, "label": saved.label, "createdAt": saved.created_at } });
            save_snapshots(&app, &archive)?;
            Ok(response)
        }
        "list" => Ok(serde_json::json!({
            "projectId": project_id,
            "snapshots": entries.iter().map(|entry| serde_json::json!({ "id": entry.id, "label": entry.label, "createdAt": entry.created_at })).collect::<Vec<_>>(),
        })),
        "get" => {
            let id = snapshot_id.ok_or("snapshot_id is required to get a snapshot")?;
            let entry = entries
                .iter()
                .find(|entry| entry.id == id)
                .ok_or("Snapshot not found")?;
            Ok(
                serde_json::json!({ "id": entry.id, "label": entry.label, "createdAt": entry.created_at, "project": entry.project }),
            )
        }
        _ => Err("action must be create, list, or get".to_string()),
    }
}

/// Store, list, or retrieve a reviewable talking-head rough-cut proposal.
/// Applying a proposal is intentionally handled in the webview bridge, where
/// it can validate the live timeline and use FreeCut's real undo history.
#[tauri::command]
pub async fn sclip_rough_cut_proposal(
    app: AppHandle,
    action: String,
    project_id: String,
    proposal_id: Option<String>,
    proposal: Option<Value>,
) -> Result<Value, String> {
    let mut archive = load_rough_cut_proposals(&app)?;
    archive.version = 1;
    let entries = archive.projects.entry(project_id.clone()).or_default();

    match action.as_str() {
        "save" => {
            let proposal = proposal.ok_or("proposal is required to save a rough-cut proposal")?;
            let entry = RoughCutProposalEntry {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: now_millis(),
                proposal,
            };
            entries.push(entry);
            if entries.len() > 50 {
                let keep_from = entries.len() - 50;
                entries.drain(0..keep_from);
            }
            let saved = entries.last().expect("proposal was pushed");
            let response = serde_json::json!({
                "success": true,
                "proposal": { "id": saved.id, "createdAt": saved.created_at, "data": saved.proposal },
            });
            save_rough_cut_proposals(&app, &archive)?;
            Ok(response)
        }
        "list" => Ok(serde_json::json!({
            "projectId": project_id,
            "proposals": entries.iter().map(|entry| serde_json::json!({
                "id": entry.id,
                "createdAt": entry.created_at,
                "summary": entry.proposal.get("summary"),
                "scriptRevision": entry.proposal.get("scriptRevision"),
            })).collect::<Vec<_>>(),
        })),
        "get" => {
            let id = proposal_id.ok_or("proposal_id is required to get a rough-cut proposal")?;
            let entry = entries
                .iter()
                .find(|entry| entry.id == id)
                .ok_or("Rough-cut proposal not found")?;
            Ok(
                serde_json::json!({ "id": entry.id, "createdAt": entry.created_at, "proposal": entry.proposal }),
            )
        }
        _ => Err("action must be save, list, or get".to_string()),
    }
}

/// Store a plan after the webview has checked its evidence and revision. This
/// command intentionally cannot execute the plan; the relevant FreeCut tool
/// validates again immediately before every mutation.
#[tauri::command]
pub async fn sclip_edit_plan(
    app: AppHandle,
    action: String,
    project_id: String,
    plan_id: Option<String>,
    plan: Option<Value>,
) -> Result<Value, String> {
    let mut archive = load_edit_plans(&app)?;
    archive.version = 1;
    let entries = archive.projects.entry(project_id.clone()).or_default();
    match action.as_str() {
        "save" => {
            let plan = plan.ok_or("plan is required to save an edit plan")?;
            let entry = EditPlanEntry {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: now_millis(),
                plan,
            };
            entries.push(entry);
            if entries.len() > 100 {
                let keep_from = entries.len() - 100;
                entries.drain(0..keep_from);
            }
            let saved = entries.last().expect("edit plan was pushed");
            let response = serde_json::json!({
                "success": true,
                "plan": { "id": saved.id, "createdAt": saved.created_at, "data": saved.plan },
            });
            save_edit_plans(&app, &archive)?;
            Ok(response)
        }
        "list" => Ok(serde_json::json!({
            "projectId": project_id,
            "plans": entries.iter().map(|entry| serde_json::json!({
                "id": entry.id, "createdAt": entry.created_at,
                "title": entry.plan.get("title"), "projectRevision": entry.plan.get("projectRevision"),
            })).collect::<Vec<_>>(),
        })),
        "get" => {
            let id = plan_id.ok_or("plan_id is required to get an edit plan")?;
            let entry = entries
                .iter()
                .find(|entry| entry.id == id)
                .ok_or("Edit plan not found")?;
            Ok(
                serde_json::json!({ "id": entry.id, "createdAt": entry.created_at, "plan": entry.plan }),
            )
        }
        _ => Err("action must be save, list, or get".to_string()),
    }
}

/// Persist an explicit correction to a plan/operation. SCLIP treats these as
/// learning data for future suggestions, never as an instruction to silently
/// replay a change in another project.
#[tauri::command]
pub async fn sclip_correction_event(
    app: AppHandle,
    action: String,
    project_id: String,
    plan_id: Option<String>,
    operation_id: Option<String>,
    outcome: Option<String>,
    correction: Option<Value>,
) -> Result<Value, String> {
    let mut archive = load_corrections(&app)?;
    archive.version = 1;
    match action.as_str() {
        "record" => {
            let outcome = outcome.unwrap_or_default();
            if !["accepted", "rejected", "modified", "undone"].contains(&outcome.as_str()) {
                return Err("outcome must be accepted, rejected, modified, or undone".to_string());
            }
            let correction = correction.ok_or("correction is required to record an event")?;
            validate_sclip_structured_value(&correction)?;
            archive.events.push(CorrectionEvent {
                id: uuid::Uuid::new_v4().to_string(),
                project_id,
                plan_id,
                operation_id,
                outcome,
                correction,
                timestamp: now_millis(),
            });
            if archive.events.len() > 1_000 {
                let keep_from = archive.events.len() - 1_000;
                archive.events.drain(0..keep_from);
            }
            let saved = archive.events.last().expect("correction was pushed");
            let response = serde_json::json!({ "success": true, "event": saved });
            save_corrections(&app, &archive)?;
            Ok(response)
        }
        "list" => Ok(serde_json::json!({
            "projectId": project_id,
            "events": archive.events.iter().rev().filter(|event| event.project_id == project_id).take(100).collect::<Vec<_>>(),
        })),
        "reset_project" => {
            let before = archive.events.len();
            archive.events.retain(|event| event.project_id != project_id);
            let removed = before - archive.events.len();
            save_corrections(&app, &archive)?;
            Ok(serde_json::json!({ "success": true, "projectId": project_id, "removed": removed }))
        }
        _ => Err("action must be record, list, or reset_project".to_string()),
    }
}

/// Private, on-device observability for SCLIP agent actions. It deliberately
/// records operational metadata, not prompts, media contents, or credentials.
#[tauri::command]
pub async fn sclip_agent_audit(
    app: AppHandle,
    action: String,
    call_id: Option<String>,
    tool: Option<String>,
    project_id: Option<String>,
    phase: Option<String>,
    detail: Option<String>,
) -> Result<Value, String> {
    let mut audit = load_audit(&app)?;
    audit.version = 1;
    match action.as_str() {
        "record" => {
            let call_id = call_id
                .filter(|value| !value.is_empty())
                .ok_or("call_id is required")?;
            let tool = tool
                .filter(|value| !value.is_empty())
                .ok_or("tool is required")?;
            let phase = phase
                .filter(|value| !value.is_empty())
                .ok_or("phase is required")?;
            audit.entries.push(AgentAuditEntry {
                call_id,
                tool,
                project_id,
                phase,
                detail: detail.map(|value| value.chars().take(500).collect()),
                timestamp: now_millis(),
            });
            if audit.entries.len() > 500 {
                let keep_from = audit.entries.len() - 500;
                audit.entries.drain(0..keep_from);
            }
            save_audit(&app, &audit)?;
            Ok(serde_json::json!({ "success": true, "entryCount": audit.entries.len() }))
        }
        "list" => Ok(serde_json::json!({
            "entries": audit.entries.iter().rev().take(100).collect::<Vec<_>>(),
        })),
        _ => Err("action must be record or list".to_string()),
    }
}
