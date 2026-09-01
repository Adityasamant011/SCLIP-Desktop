// Sclip MCP Server
// 2-process architecture:
//   - GUI process (Tauri app): starts a Unix socket listener + spawns `freecut --mcp-server`
//   - MCP proxy process (`freecut --mcp-server`): connects to the socket, translates
//     stdio JSON-RPC <-> socket protocol, so Hermes (in PTY) can call tools that
//     dispatch to the webview via Tauri events.
//
// Tool call flow:
//   Hermes (PTY) → MCP stdio → freecut --mcp-server → Unix socket → Tauri GUI
//   → emit 'sclip-tool-call' → webview (sclip-mcp-bridge.ts) → Zustand dispatch
//   → invoke('handle_tool_result') → Tauri GUI → oneshot channel → stdio JSON-RPC → Hermes

use rmcp::handler::server::tool::{Parameters, ToolCallContext};
use rmcp::{
    handler::server::tool::ToolRouter,
    model::*,
    service::{RequestContext, RoleServer},
    tool, tool_router, ErrorData, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc as StdArc;
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex};

// Initialize logging for standalone MCP server
// CRITICAL: Must log to stderr, NOT stdout, because stdout is used for JSON-RPC protocol
fn init_logging() {
    use std::io::Write;
    env_logger::Builder::from_default_env()
        .format(|buf, record| {
            writeln!(
                buf,
                "[{}] [{}] {}",
                chrono::Local::now().format("%H:%M:%S%.3f"),
                record.level(),
                record.args()
            )
        })
        .filter_level(log::LevelFilter::Debug)
        .target(env_logger::Target::Stderr) // Log to stderr to avoid corrupting JSON-RPC on stdout
        .init();
}

/// Unix socket path for IPC between GUI process and MCP proxy process
pub const SOCKET_PATH: &str = "/tmp/sclip-freecut-mcp.sock";

/// Tool call request from Hermes via MCP
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SclipToolCall {
    pub id: String,
    pub tool: String,
    pub args: serde_json::Value,
}

/// Tool call result sent back to Hermes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SclipToolResult {
    pub id: String,
    pub result: serde_json::Value,
    pub is_error: bool,
}

/// Tauri event names
pub const TOOL_CALL_EVENT: &str = "sclip-tool-call";
pub const TOOL_RESULT_EVENT: &str = "sclip-tool-result";

/// Tool handlers preserve their existing human-readable `OK:` / `ERROR:`
/// envelopes for compatibility with Hermes transcripts. Convert the error
/// envelope into the protocol-level MCP signal at the server boundary so
/// callers can reliably branch on `isError` instead of parsing prose.
fn mark_proxy_error_result(mut result: CallToolResult) -> CallToolResult {
    if result.content.iter().any(|content| {
        matches!(&content.raw, RawContent::Text(text) if text.text.starts_with("ERROR:"))
    }) {
        result.is_error = Some(true);
    }
    result
}

// Pending request storage for correlating requests with responses.
lazy_static::lazy_static! {
    static ref PENDING_REQUESTS: Mutex<HashMap<String, oneshot::Sender<SclipToolResult>>> =
        Mutex::new(HashMap::new());
}

// ─── Socket protocol ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
enum SocketMessage {
    ToolCall {
        id: String,
        tool: String,
        args: Value,
    },
    ToolResult {
        id: String,
        result: Value,
        is_error: bool,
    },
}

// ─── Tool input types ────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddClipArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub media_id: String,
    pub track_id: String,
    pub from_frame: u64,
    pub duration_frames: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ImportMediaArgs {
    /// Existing FreeCut project that will receive the imported media.
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// An absolute local file path or a direct http(s) media URL.
    pub source: String,
    /// "path" copies a local file into the project; "url" downloads a direct media URL.
    pub source_type: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddTextArgs {
    /// The existing FreeCut project to edit. SCLIP never creates projects.
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub text: String,
    /// Optional explicit track. When omitted, FreeCut chooses a compatible
    /// visible text track using the same placement rules as the manual editor.
    pub track_id: Option<String>,
    pub from_frame: Option<u64>,
    pub duration_frames: Option<u64>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddStickerArgs {
    /// The existing FreeCut project to edit. SCLIP never creates projects.
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// A Unicode emoji to use as a visible sticker, such as "✨", "🔥", "❤️", or "👍".
    pub emoji: String,
    /// Optional timeline start. Defaults to frame zero.
    pub from_frame: Option<u64>,
    /// Optional duration. Defaults to the editor's generated-layer duration.
    pub duration_frames: Option<u64>,
    /// Horizontal placement in canvas pixels, relative to the canvas center.
    pub x: Option<i32>,
    /// Vertical placement in canvas pixels, relative to the canvas center.
    pub y: Option<i32>,
    /// Sticker font size in pixels. Defaults to 180.
    pub size: Option<u32>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddShapeArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// rectangle, circle, triangle, ellipse, star, polygon, heart, or path.
    pub shape_type: String,
    /// default, solid, or gradient.
    pub preset: Option<String>,
    pub from_frame: Option<u64>,
    pub duration_frames: Option<u64>,
    /// Optional real FreeCut shape style properties, such as fillColor or strokeWidth.
    pub style: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SplitItemArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub frame: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddTransitionArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub from_item_id: String,
    pub to_item_id: String,
    pub transition_type: String,
    pub duration_frames: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddEffectArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub effect_type: String,
    // MCP input schemas require each property schema to be an object. A raw
    // serde_json::Value generates the boolean schema `true`, which Hermes's
    // MCP SDK correctly rejects during tools/list. Effects are key/value
    // settings, so an object is the truthful and interoperable contract.
    pub params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TrimItemArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub trim_start: Option<u64>,
    pub trim_end: Option<u64>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct MoveItemArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub new_from_frame: u64,
    pub new_track_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RemoveItemsArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RenderArgs {
    pub project_id: String,
    /// Required revision of the snapshot used to enqueue this render.
    pub expected_revision: String,
    /// max, recommended, balanced, or small. Defaults to recommended.
    pub preset: Option<String>,
    pub codec: Option<String>,
    pub quality: Option<String>,
    /// mp4, mov, webm, or mkv.
    pub container: Option<String>,
    /// off, burn, sidecar, or embedded.
    pub subtitle_mode: Option<String>,
    /// Human-readable render queue name.
    pub output_name: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GetProjectSummaryArgs {
    pub project_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GetTimelineWindowArgs {
    pub project_id: String,
    /// Window start in seconds.
    pub start_sec: f64,
    /// Window end in seconds. Capped at start_sec + 300s. Defaults to start_sec + 30s.
    pub end_sec: Option<f64>,
    /// Optional track filter IDs.
    pub tracks: Option<Vec<String>>,
    /// summary, standard, or deep. Defaults to standard.
    pub detail_level: Option<String>,
    pub include_transcript: Option<bool>,
    pub include_visual: Option<bool>,
    pub include_audio: Option<bool>,
    pub max_items: Option<usize>,
    pub max_words: Option<usize>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct InspectSegmentArgs {
    pub project_id: String,
    pub item_id: Option<String>,
    pub media_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GetProjectArgs {
    pub project_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ListProjectsArgs {}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EditorCapabilitiesArgs {}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RuntimeHealthArgs {}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ManageTracksArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// add, update, or remove. Removal is rejected while the track contains items.
    pub action: String,
    /// video or audio; used by add (defaults to video).
    pub kind: Option<String>,
    /// Optional human-readable name when adding a track.
    pub name: Option<String>,
    /// Required for update and remove.
    pub track_id: Option<String>,
    /// For update: name, locked, visible, muted, solo, volume, or order.
    pub updates: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ReviewPreviewArgs {
    pub project_id: String,
    /// Project frame to review. Omit to review the frame currently shown in FreeCut's preview.
    pub frame: Option<u64>,
    /// Optional set of 1–8 project frames. SCLIP captures each composited frame
    /// through FreeCut's authoritative preview and reports every result.
    pub frames: Option<Vec<u64>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ListMediaArgs {
    /// The existing project whose imported media should be inspected.
    pub project_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct InspectMediaArgs {
    /// The existing project id.
    pub project_id: String,
    /// Imported media id returned by video_list_media or reference.
    pub media_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ResolveReferenceArgs {
    /// Compact reference copied by the FreeCut UI, e.g. @sclip/item/1a2b3c4d.
    pub reference: String,
    /// Optional project id when the referenced project is not already open.
    pub project_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TranscribeArgs {
    pub project_id: String,
    /// Required only because caption_mode can mutate the timeline.
    pub expected_revision: Option<String>,
    /// Imported media id returned by video_list_media.
    pub media_id: String,
    pub language: Option<String>,
    /// "items" creates editable caption items; "virtual" enables linked transcript captions.
    pub caption_mode: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GetTranscriptArgs {
    /// Existing project whose imported media owns the transcript.
    pub project_id: String,
    /// Imported media id returned by video_list_media or video_transcribe.
    pub media_id: String,
    /// Optional inclusive start time in source seconds.
    pub start_sec: Option<f64>,
    /// Optional exclusive end time in source seconds.
    pub end_sec: Option<f64>,
    /// Maximum timestamped segments to return (1–300; defaults to 120).
    pub max_segments: Option<u32>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct BuildSemanticMapArgs {
    /// Existing project that owns the imported source media.
    pub project_id: String,
    /// Imported media id returned by video_list_media.
    pub media_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ReadScriptArgs {
    pub project_id: String,
    /// Optional imported media id to limit the script to one source asset.
    pub media_id: Option<String>,
    /// Optional inclusive timeline frame for paging.
    pub start_frame: Option<u64>,
    /// Optional exclusive timeline frame for paging.
    pub end_frame: Option<u64>,
    /// Maximum words to return (1-1000, default 300).
    pub max_words: Option<u32>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct FindSpeechArgs {
    pub project_id: String,
    /// "phrase" (requires query) or "filler".
    pub kind: String,
    pub query: Option<String>,
    pub media_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SearchMediaArgs {
    pub project_id: String,
    /// What the desired B-roll or local media should depict. Search uses only
    /// local filenames, tags, and existing visual-caption evidence.
    pub query: String,
    /// Maximum assets to return (1-50, default 12).
    pub max_results: Option<u32>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SearchVisualSegmentsArgs {
    pub project_id: String,
    /// Semantic search query describing what is visible (e.g. "pouring espresso into cup", "person speaking on camera").
    pub query: String,
    /// Optional list of media IDs to restrict search scope.
    pub media_ids: Option<Vec<String>>,
    /// Minimum usable segment duration in seconds (default 1.0s).
    pub min_usable_duration_sec: Option<f64>,
    /// Maximum segments to return (1-50, default 10).
    pub limit: Option<u32>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ApplyScriptArgs {
    pub project_id: String,
    /// Operations currently support { type: "remove_words", word_refs: [{ item_id, word_id }] }.
    pub operations: Vec<serde_json::Value>,
    /// Must be true after reviewing the returned preview; otherwise no timeline mutation occurs.
    pub confirm: Option<bool>,
    /// Required when confirm=true. This is the live composed project revision returned by video_get_project.
    pub expected_revision: Option<String>,
    /// Required when confirm=true. This is the scriptRevision returned by the preview and protects word placement.
    pub expected_script_revision: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RoughCutProposalArgs {
    pub project_id: String,
    /// save, list, get, preview_apply, or apply.
    pub action: String,
    /// Required for get, preview_apply, and apply.
    pub proposal_id: Option<String>,
    /// Required when action=save. Structured operations currently support only
    /// remove_words with stable { item_id, word_id } word references.
    pub proposal: Option<serde_json::Value>,
    /// Required when action=apply. Must equal the live composed project revision returned by video_get_project.
    pub expected_revision: Option<String>,
    /// Required when action=apply. Must equal the live scriptRevision returned by preview_apply.
    pub expected_script_revision: Option<String>,
    /// Required when action=apply after inspecting preview_apply.
    pub confirm: Option<bool>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EditPlanArgs {
    pub project_id: String,
    /// save, list, get, validate, preview, or execute. Execute requires confirm=true.
    pub action: String,
    pub plan_id: Option<String>,
    /// Required for save. It must be evidence-grounded and tied to the current visible project revision.
    pub plan: Option<serde_json::Value>,
    /// Required for execute after a preview.
    pub confirm: Option<bool>,
    /// Required for execute; must equal the live visible project revision.
    pub expected_revision: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EditorialEvidenceArgs {
    pub project_id: String,
    /// The editorial question used to select a bounded evidence view.
    pub objective: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EditingGuidanceArgs {
    /// Supported topics include cut_motivation, pacing, dialogue, punch_in, retakes, filler, broll, breaths, j_cut, phrasing, ducking, off_beat, chapters, etc.
    pub topics: Option<Vec<String>>,
    /// Optional content genres to filter applicable conventions (e.g. talking_head, youtube_longform, short_form, tutorial, vlog, gaming, sports, documentary, comedy).
    pub content_types: Option<Vec<String>>,
    /// Optional segment genres for mixed-project window reasoning.
    pub segment_genres: Option<Vec<String>>,
    /// Stated project intent (e.g. "cinematic documentary", "fast explainer").
    pub project_intent: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct CorrectionEventArgs {
    pub project_id: String,
    /// record, list, or reset_project.
    pub action: String,
    pub plan_id: Option<String>,
    pub operation_id: Option<String>,
    /// accepted, rejected, modified, or undone when recording.
    pub outcome: Option<String>,
    /// Structured correction details; never an API key or private prompt history.
    pub correction: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct UnderstandArgs {
    pub project_id: String,
    /// Imported video or image id returned by video_list_media.
    pub media_id: String,
    /// Optional focus supplied by the user; FreeCut's local analysis results remain the source of truth.
    pub prompt: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct UpdateItemArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    /// FreeCut-supported fields such as text, fontSize, volume, fades, speed, or audioDucking.
    pub updates: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct UpdateTransformArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    /// Numeric transform fields: x, y, width, height, rotation, opacity, scaleX, scaleY, anchorX, anchorY.
    pub transform: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AddKeyframeArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub property: String,
    pub frame: f64,
    pub value: f64,
    pub easing: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ManageTransitionArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub transition_id: String,
    /// "update" or "remove".
    pub action: String,
    pub updates: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ManageEffectArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    pub item_id: String,
    pub effect_id: String,
    /// "update", "toggle", or "remove".
    pub action: String,
    /// For update: optional enabled, effect_type, and params object.
    pub updates: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TimelineEditArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// ripple_delete, reverse, close_gap, set_in_out, clear_in_out, rate_stretch, remove_silence, or remove_filler_words.
    pub action: String,
    pub values: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct AnalyzeAudioArgs {
    pub project_id: String,
    /// Real audio/video timeline item IDs. The analyzer only reads these placements.
    pub item_ids: Vec<String>,
    /// signal (decoded waveform) or speech (timestamped transcript); defaults to signal.
    pub mode: Option<String>,
    /// Optional detector settings such as minSilenceMs, paddingStartMs, and paddingEndMs.
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct HistoryArgs {
    pub project_id: String,
    /// Required live project revision returned by video_get_project.
    pub expected_revision: String,
    /// undo or redo. Uses the exact same history as the FreeCut editor toolbar.
    pub action: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ManageMediaArgs {
    pub project_id: String,
    /// Required when action=relink; proxy actions do not change the timeline.
    pub expected_revision: Option<String>,
    pub media_id: String,
    /// generate_proxy, cancel_proxy, or relink.
    pub action: String,
    /// Absolute replacement file path; required only for relink.
    pub source: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EditingMemoryArgs {
    /// get, update_preferences, set_project_context, or record_feedback.
    pub action: String,
    pub project_id: Option<String>,
    /// Structured editing fields such as captionStyle, pacing, musicMood, colors, or effects.
    pub values: Option<serde_json::Map<String, serde_json::Value>>,
    /// Direct user feedback to preserve inside SCLIP's isolated profile.
    pub feedback: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ProjectSnapshotArgs {
    pub project_id: String,
    /// Required when action=restore because it replaces the project timeline.
    pub expected_revision: Option<String>,
    /// create, list, or restore.
    pub action: String,
    /// Human-readable label when creating a recovery point.
    pub label: Option<String>,
    /// Required when restoring a listed snapshot.
    pub snapshot_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GenerateAudioArgs {
    pub project_id: String,
    /// Required when insert is not false because insertion changes the timeline.
    pub expected_revision: Option<String>,
    /// music for local MusicGen or speech for local Kokoro text-to-speech.
    pub kind: String,
    /// Music description or narration text.
    pub prompt: String,
    /// Optional local model id. Use the application's default when omitted.
    pub model: Option<String>,
    pub voice: Option<String>,
    pub speed: Option<f64>,
    /// Music length in seconds (1–30); ignored for speech.
    pub duration_seconds: Option<f64>,
    /// Insert an editable audio clip after importing; defaults to true.
    pub insert: Option<bool>,
    pub from_frame: Option<u64>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DetectScenesArgs {
    pub project_id: String,
    /// Required when split=true because it changes the timeline.
    pub expected_revision: Option<String>,
    /// Real timeline video item id to analyze.
    pub item_id: String,
    /// histogram (fast) or adaptive (more precise); defaults to histogram.
    pub method: Option<String>,
    /// Split the actual visible timeline clip at detected cuts; defaults to false.
    pub split: Option<bool>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RenderStatusArgs {
    pub project_id: Option<String>,
    pub job_id: Option<String>,
    /// Omit to inspect; use "cancel" only with job_id to cancel that queued/rendering job.
    pub action: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ValidateProjectArgs {
    /// The open FreeCut project to inspect. This is read-only and checks the live timeline.
    pub project_id: String,
    /// preflight checks edit safety; render additionally checks export readiness.
    pub mode: Option<String>,
}

// ─── GUI-mode MCP server (has AppHandle, emits Tauri events) ─────────────────

#[derive(Clone)]
pub struct SclipMcpServer {
    app_handle: tauri::AppHandle,
    tool_router: ToolRouter<SclipMcpServer>,
}

impl SclipMcpServer {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle: app_handle.clone(),
            // `#[tool_router]` generates this populated router. Constructing
            // an empty ToolRouter here silently exposes zero tools.
            tool_router: Self::tool_router(),
        }
    }

    /// Emit a tool call to the webview and wait for the result via oneshot channel.
    /// This is called from within async MCP tool handlers.
    async fn emit_and_wait(&self, tool_name: &str, args: Value) -> String {
        let call_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        {
            let mut pending = PENDING_REQUESTS.lock().await;
            pending.insert(call_id.clone(), tx);
        }

        let _ = self.app_handle.emit(
            TOOL_CALL_EVENT,
            serde_json::json!({
                "id": call_id,
                "tool": tool_name,
                "args": args,
            }),
        );

        // Cold-starting a local ML model is real editor work and can take more
        // than a minute. Do not report it as a failed edit merely because the
        // normal UI-operation timeout elapsed.
        let timeout_seconds = match tool_name {
            "video_generate_audio"
            | "video_understand"
            | "video_transcribe"
            | "video_detect_scenes"
            | "video_analyze_audio"
            | "video_review_preview" => 300,
            _ => 60,
        };
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds), rx).await {
            Ok(Ok(result)) => {
                if result.is_error {
                    format!("ERROR: {}", result.result)
                } else {
                    format!("OK: {}", result.result)
                }
            }
            Ok(Err(_)) => "ERROR: Channel closed".to_string(),
            Err(_) => {
                PENDING_REQUESTS.lock().await.remove(&call_id);
                format!("ERROR: {tool_name} timed out after {timeout_seconds}s")
            }
        }
    }

    /// Start the MCP server (GUI mode — serves on stdin/stdout)
    pub async fn start(self: StdArc<Self>) -> anyhow::Result<()> {
        let transport = (tokio::io::stdin(), tokio::io::stdout());
        let server = (*self).clone();
        tokio::spawn(async move {
            // `serve_server` only performs the MCP handshake and returns a
            // `RunningService`.  Dropping that value immediately cancels the
            // request loop, which made every client see a closed connection
            // immediately after initialization.
            if let Ok(running) = rmcp::service::serve_server(server, transport).await {
                let _ = running.waiting().await;
            }
        });
        Ok(())
    }
}

#[tool_router]
impl SclipMcpServer {
    #[tool(
        description = "Import a local media file or direct media URL into the active SCLIP project's visible media library."
    )]
    async fn video_import_media(&self, Parameters(args): Parameters<ImportMediaArgs>) -> String {
        self.emit_and_wait("video_import_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a media clip to the timeline")]
    async fn video_add_clip(&self, Parameters(args): Parameters<AddClipArgs>) -> String {
        self.emit_and_wait("video_add_clip", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a text or title layer to the visible SCLIP timeline")]
    async fn video_add_text(&self, Parameters(args): Parameters<AddTextArgs>) -> String {
        self.emit_and_wait("video_add_text", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Add a visible emoji sticker as its own overlay layer. Use a Unicode emoji such as ✨, 🔥, ❤️, 👍, 😍, or 🎉; this is for emoji stickers, not external image files."
    )]
    async fn video_add_sticker(&self, Parameters(args): Parameters<AddStickerArgs>) -> String {
        self.emit_and_wait("video_add_sticker", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Add a native SCLIP shape layer (rectangle, circle, triangle, ellipse, star, polygon, heart, or path) to the visible timeline."
    )]
    async fn video_add_shape(&self, Parameters(args): Parameters<AddShapeArgs>) -> String {
        self.emit_and_wait("video_add_shape", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Split a clip at a specific frame")]
    async fn video_split(&self, Parameters(args): Parameters<SplitItemArgs>) -> String {
        self.emit_and_wait("video_split", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a transition between two clips")]
    async fn video_add_transition(
        &self,
        Parameters(args): Parameters<AddTransitionArgs>,
    ) -> String {
        self.emit_and_wait("video_add_transition", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add an effect to a clip")]
    async fn video_add_effect(&self, Parameters(args): Parameters<AddEffectArgs>) -> String {
        self.emit_and_wait("video_add_effect", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Update, toggle, or remove an existing visible SCLIP effect.")]
    async fn video_manage_effect(&self, Parameters(args): Parameters<ManageEffectArgs>) -> String {
        self.emit_and_wait("video_manage_effect", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Trim start/end of a clip")]
    async fn video_trim(&self, Parameters(args): Parameters<TrimItemArgs>) -> String {
        self.emit_and_wait("video_trim", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Move a clip on the timeline")]
    async fn video_move(&self, Parameters(args): Parameters<MoveItemArgs>) -> String {
        self.emit_and_wait("video_move", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Remove clips from the timeline")]
    async fn video_remove(&self, Parameters(args): Parameters<RemoveItemsArgs>) -> String {
        self.emit_and_wait("video_remove", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Render the project to a video file")]
    async fn video_render(&self, Parameters(args): Parameters<RenderArgs>) -> String {
        self.emit_and_wait("video_render", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Get a compact, bounded high-level summary of the project (duration, tracks, item counts, media asset inventory, transcript and visual overview). Use this for orientation on long-form projects before requesting specific timeline windows."
    )]
    async fn video_get_project_summary(
        &self,
        Parameters(args): Parameters<GetProjectSummaryArgs>,
    ) -> String {
        self.emit_and_wait("video_get_project_summary", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Get a bounded slice of the timeline strictly within [start_sec, end_sec]. Returns only overlapping items, sliced transcript words, visual moments, and silence ranges. Use this to inspect specific sections of long-form projects without payload explosion."
    )]
    async fn video_get_timeline_window(
        &self,
        Parameters(args): Parameters<GetTimelineWindowArgs>,
    ) -> String {
        self.emit_and_wait("video_get_timeline_window", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Deeply inspect a specific timeline item or media segment without loading the rest of the project."
    )]
    async fn video_inspect_segment(
        &self,
        Parameters(args): Parameters<InspectSegmentArgs>,
    ) -> String {
        self.emit_and_wait("video_inspect_segment", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Get current project state")]
    async fn video_get_project(&self, Parameters(args): Parameters<GetProjectArgs>) -> String {
        self.emit_and_wait("video_get_project", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "List all projects in workspace")]
    async fn video_list_projects(&self, _parameters: Parameters<ListProjectsArgs>) -> String {
        self.emit_and_wait("video_list_projects", serde_json::json!({}))
            .await
    }

    #[tool(
        description = "List the real SCLIP effect registry, transition presentations, editable Properties-panel fields, transform controls, and built-in AI workflows. Call this before using an effect, transition, or property you have not already inspected; never guess IDs or parameter names."
    )]
    async fn video_editor_capabilities(
        &self,
        _parameters: Parameters<EditorCapabilitiesArgs>,
    ) -> String {
        self.emit_and_wait("video_editor_capabilities", serde_json::json!({}))
            .await
    }

    #[tool(
        description = "Manage real SCLIP tracks. Add named video/audio tracks for primary footage, B-roll, graphics, captions, music, or voiceover; update track visibility/locking/order; or remove an empty track. Use video_get_project before and after changes."
    )]
    async fn video_manage_tracks(&self, Parameters(args): Parameters<ManageTracksArgs>) -> String {
        self.emit_and_wait("video_manage_tracks", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Capture and inspect the actual composited SCLIP preview at a frame using the local vision-language model. Use after visual edits to review what the audience will see, including stacking, transforms, text, effects, and visible tracks."
    )]
    async fn video_review_preview(
        &self,
        Parameters(args): Parameters<ReviewPreviewArgs>,
    ) -> String {
        self.emit_and_wait("video_review_preview", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "List media that has actually been imported into a project's SCLIP media library. Returns explicit isOnTimeline and placementCount so you never confuse imported assets with timeline clips."
    )]
    async fn video_list_media(&self, Parameters(args): Parameters<ListMediaArgs>) -> String {
        self.emit_and_wait("video_list_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Search the active project's local media library for B-roll using only stored filenames, tags, and visual-analysis captions. Returns ranked, timestamped evidence and exact media IDs; it never downloads stock media or claims unanalysed assets depict a query."
    )]
    async fn video_search_media(&self, Parameters(args): Parameters<SearchMediaArgs>) -> String {
        self.emit_and_wait("video_search_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Search the active project's local media library for time-indexed sub-clip visual segments using multimodal CLIP embeddings and scene semantics. Returns exact start_sec/end_sec ranges, shot types, motion levels, and calibrated semantic scores."
    )]
    async fn video_search_visual_segments(
        &self,
        Parameters(args): Parameters<SearchVisualSegmentsArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_search_visual_segments",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Inspect an imported media asset in detail, including duration, dimensions, analysis status, and exact timeline placements."
    )]
    async fn video_inspect_media(&self, Parameters(args): Parameters<InspectMediaArgs>) -> String {
        self.emit_and_wait("video_inspect_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Resolve a compact reference copied from SCLIP, such as @sclip/item/1a2b3c4d, to the exact project, item/media/transition IDs and state. Resolve it before editing a user-referenced target."
    )]
    async fn video_resolve_reference(
        &self,
        Parameters(args): Parameters<ResolveReferenceArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_resolve_reference",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Transcribe imported media locally and persist its timestamped transcript. Call video_get_transcript afterwards when the spoken words are needed for a semantic edit."
    )]
    async fn video_transcribe(&self, Parameters(args): Parameters<TranscribeArgs>) -> String {
        self.emit_and_wait("video_transcribe", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read a bounded, timestamped page of an existing local transcript, including word timings when available. Use it to ground talking-head cut proposals; do not invent spoken content."
    )]
    async fn video_get_transcript(
        &self,
        Parameters(args): Parameters<GetTranscriptArgs>,
    ) -> String {
        self.emit_and_wait("video_get_transcript", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read the timeline's speech as a word-level script with stable source wordId, itemId placement, and exact source/timeline timings. Use this before proposing a talking-head edit. Pair wordId with itemId in video_apply_script."
    )]
    async fn video_read_script(&self, Parameters(args): Parameters<ReadScriptArgs>) -> String {
        self.emit_and_wait("video_read_script", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Find grounded speech on the visible SCLIP timeline. Use kind=phrase with a query, or kind=filler for unambiguous hesitation sounds. Returns stable word references; this never edits the timeline."
    )]
    async fn video_find_speech(&self, Parameters(args): Parameters<FindSpeechArgs>) -> String {
        self.emit_and_wait("video_find_speech", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Preview or apply a transcript-script edit. Currently supports remove_words using stable { item_id, word_id } references returned by video_read_script/video_find_speech. Call first without confirm to inspect exact ranges, projectRevision, and scriptRevision; only confirm=true with expected_revision=projectRevision and expected_script_revision=scriptRevision performs FreeCut's deterministic split/remove/ripple operation, which remains undoable and rejects stale state."
    )]
    async fn video_apply_script(&self, Parameters(args): Parameters<ApplyScriptArgs>) -> String {
        self.emit_and_wait("video_apply_script", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Save, list, inspect, preview, or safely apply a SCLIP rough-cut proposal. A proposal is project-local and must include a summary, a scriptRevision returned by video_read_script, and reviewable remove_words operations using stable word references. preview_apply never changes the timeline. apply requires confirm=true, expected_revision=projectRevision, and expected_script_revision=scriptRevision; it creates a named project recovery snapshot, then performs undoable FreeCut transcript edits."
    )]
    async fn video_rough_cut_proposal(
        &self,
        Parameters(args): Parameters<RoughCutProposalArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_rough_cut_proposal",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Return a bounded, revision-bound editorial evidence bundle for one objective. It joins existing script, source visual observations, semantic-map candidates, timeline summary, and explicit creator context without dumping the project or full transcript. Candidates are evidence for Hermes to judge, never automatic cut instructions."
    )]
    async fn video_get_editorial_evidence(
        &self,
        Parameters(args): Parameters<EditorialEvidenceArgs>,
    ) -> String {
        self.emit_and_wait("video_get_editorial_evidence", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Retrieve small, versioned SCLIP editing principles for the supplied topics. This is deterministic reference retrieval, not an editorial planner or a giant system prompt."
    )]
    async fn video_get_editing_guidance(
        &self,
        Parameters(args): Parameters<EditingGuidanceArgs>,
    ) -> String {
        self.emit_and_wait("video_get_editing_guidance", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Save, list, inspect, validate, preview, or execute a general SCLIP edit plan. Hermes is the sole planner. V1 executes only approved deterministic FreeCut operations, validates evidence/revision/args before mutation, creates a recovery snapshot, and returns deterministic plus perceptual verification."
    )]
    async fn video_edit_plan(&self, Parameters(args): Parameters<EditPlanArgs>) -> String {
        self.emit_and_wait("video_edit_plan", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Record, list, or reset project-scoped structured creator corrections to SCLIP plan operations. Corrections are local learning data, not commands to replay edits automatically in another project."
    )]
    async fn video_correction_event(
        &self,
        Parameters(args): Parameters<CorrectionEventArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_correction_event",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Build and persist SCLIP's grounded semantic map for one imported source asset. It joins existing timestamped transcript and source-footage visual analysis into review candidates such as fillers, repeated lines, and speech gaps; it never cuts automatically. Run video_transcribe and video_understand first when evidence is missing."
    )]
    async fn video_build_semantic_map(
        &self,
        Parameters(args): Parameters<BuildSemanticMapArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_build_semantic_map",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(description = "Analyze video content with AI")]
    async fn video_understand(&self, Parameters(args): Parameters<UnderstandArgs>) -> String {
        self.emit_and_wait("video_understand", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Update a real timeline item's text style, audio settings, speed, fades, visibility, or other supported SCLIP item fields."
    )]
    async fn video_update_item(&self, Parameters(args): Parameters<UpdateItemArgs>) -> String {
        self.emit_and_wait("video_update_item", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Update a real timeline item's transform: position, size, rotation, opacity, scale, or anchor."
    )]
    async fn video_update_transform(
        &self,
        Parameters(args): Parameters<UpdateTransformArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_update_transform",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(description = "Add a numeric animation keyframe to a real SCLIP timeline item.")]
    async fn video_add_keyframe(&self, Parameters(args): Parameters<AddKeyframeArgs>) -> String {
        self.emit_and_wait("video_add_keyframe", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Update or remove an existing visible SCLIP transition.")]
    async fn video_manage_transition(
        &self,
        Parameters(args): Parameters<ManageTransitionArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_manage_transition",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Perform a real native timeline edit: ripple delete, reverse, close a gap, set/clear in-out, or rate stretch."
    )]
    async fn video_timeline_edit(&self, Parameters(args): Parameters<TimelineEditArgs>) -> String {
        self.emit_and_wait("video_timeline_edit", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Analyze real audio/speech gaps for selected timeline items without editing them. signal mode reads decoded waveform; speech mode uses the local timestamped transcript. It returns source-time silence candidates and limitations. Review the result, then use FreeCut's normal timeline edit with explicit approval; never treat a transcript gap as silence by itself."
    )]
    async fn video_analyze_audio(&self, Parameters(args): Parameters<AnalyzeAudioArgs>) -> String {
        self.emit_and_wait("video_analyze_audio", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Undo or redo a visible SCLIP timeline change using the editor's real history, then save the restored project."
    )]
    async fn video_history(&self, Parameters(args): Parameters<HistoryArgs>) -> String {
        self.emit_and_wait("video_history", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Generate/cancel a real SCLIP proxy for video media, or relink missing media from an absolute replacement file path."
    )]
    async fn video_manage_media(&self, Parameters(args): Parameters<ManageMediaArgs>) -> String {
        self.emit_and_wait("video_manage_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read or update SCLIP-only editing preferences and feedback. This is isolated to SCLIP and never accesses the user's separate personal-agent memory."
    )]
    async fn video_editing_memory(
        &self,
        Parameters(args): Parameters<EditingMemoryArgs>,
    ) -> String {
        self.emit_and_wait("video_editing_memory", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Create, list, or restore persistent SCLIP project recovery snapshots. Restore is destructive and should be confirmed unless explicitly requested."
    )]
    async fn video_project_snapshot(
        &self,
        Parameters(args): Parameters<ProjectSnapshotArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_project_snapshot",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Generate local MusicGen music or Kokoro speech, import it into the visible SCLIP media library, and optionally insert an editable audio clip."
    )]
    async fn video_generate_audio(
        &self,
        Parameters(args): Parameters<GenerateAudioArgs>,
    ) -> String {
        self.emit_and_wait("video_generate_audio", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Run SCLIP's local scene detection on a visible video clip, persist the results for the Scene Browser, and optionally split that real timeline clip at cuts."
    )]
    async fn video_detect_scenes(&self, Parameters(args): Parameters<DetectScenesArgs>) -> String {
        self.emit_and_wait("video_detect_scenes", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Inspect a render job's actual queue progress, or cancel one by id.")]
    async fn video_render_status(&self, Parameters(args): Parameters<RenderStatusArgs>) -> String {
        self.emit_and_wait("video_render_status", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read-only SCLIP preflight for the live project. Reports missing media, unintended same-track overlaps, locked/hidden tracks, empty projects, and render readiness. Run before a multi-step edit and immediately before rendering."
    )]
    async fn video_validate_project(
        &self,
        Parameters(args): Parameters<ValidateProjectArgs>,
    ) -> String {
        self.emit_and_wait(
            "video_validate_project",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }
}

impl ServerHandler for SclipMcpServer {
    fn get_info(&self) -> InitializeResult {
        InitializeResult {
            protocol_version: ProtocolVersion::default(),
            capabilities: ServerCapabilities::default(),
            server_info: Implementation {
                name: "sclip".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            instructions: None,
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tool_router.list_all(),
            next_cursor: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self.tool_router
            .call(ToolCallContext::new(self, request, context))
            .await?;
        Ok(mark_proxy_error_result(result))
    }
}

/// Initialize and start the MCP server (with Tauri app handle for GUI mode)
/// This runs the MCP server on stdio, which is what Hermes connects to.
/// Tool calls are proxied to the webview via Tauri events.
pub async fn start_mcp_server_gui(app_handle: tauri::AppHandle) -> anyhow::Result<()> {
    let server = StdArc::new(SclipMcpServer::new(app_handle));
    server.clone().start().await?;
    Ok(())
}

/// Initialize and start the MCP server (with Tauri app handle for GUI mode)
/// This runs the MCP server on stdio, which is what Hermes connects to.
/// Tool calls are proxied to the webview via Tauri events.
pub async fn start_mcp_server(
    app_handle: tauri::AppHandle,
) -> anyhow::Result<StdArc<SclipMcpServer>> {
    let server = StdArc::new(SclipMcpServer::new(app_handle));
    server.clone().start().await?;
    Ok(server)
}

// ─── Standalone MCP server (connects to Unix socket, proxies to GUI) ─────────

#[derive(Clone)]
pub struct SocketMcpServer {
    tool_router: ToolRouter<SocketMcpServer>,
}

impl SocketMcpServer {
    pub fn new() -> Self {
        Self {
            // Populate the macro-generated routes instead of advertising an
            // empty tool registry to Hermes.
            tool_router: Self::tool_router(),
        }
    }

    /// Forward a tool call to the GUI process via Unix socket and wait for result.
    async fn proxy_tool_call(&self, tool_name: &str, args: Value) -> String {
        let call_id = uuid::Uuid::new_v4().to_string();

        let result = async {
            let stream = tokio::net::UnixStream::connect(SOCKET_PATH).await?;
            let (reader, writer) = stream.into_split();

            // Send the tool call via socket
            let msg = SocketMessage::ToolCall {
                id: call_id.clone(),
                tool: tool_name.to_string(),
                args: serde_json::to_value(args).unwrap_or(Value::Null),
            };
            let msg_json = serde_json::to_string(&msg)?;
            let mut buf_writer = tokio::io::BufWriter::new(writer);
            tokio::io::AsyncWriteExt::write_all(&mut buf_writer, msg_json.as_bytes()).await?;
            tokio::io::AsyncWriteExt::write_all(&mut buf_writer, b"\n").await?;
            tokio::io::AsyncWriteExt::flush(&mut buf_writer).await?;

            // Read the response line
            let mut buf_reader = tokio::io::BufReader::new(reader);
            let mut response_line = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut buf_reader, &mut response_line).await?;

            let response: SocketMessage = serde_json::from_str(response_line.trim())?;
            match response {
                SocketMessage::ToolResult {
                    id,
                    result,
                    is_error,
                } if id == call_id => {
                    if is_error {
                        Ok::<String, Box<dyn std::error::Error + Send + Sync>>(format!(
                            "ERROR: {}",
                            result
                        ))
                    } else {
                        Ok(format!("OK: {}", result))
                    }
                }
                _ => Ok("ERROR: Unexpected response from socket".to_string()),
            }
        }
        .await;

        match result {
            Ok(s) => s,
            Err(e) => format!("ERROR: Socket proxy failed: {}", e),
        }
    }
}

#[tool_router]
impl SocketMcpServer {
    #[tool(
        description = "Import a local media file or direct media URL into the active SCLIP project's visible media library."
    )]
    async fn video_import_media(&self, Parameters(args): Parameters<ImportMediaArgs>) -> String {
        self.proxy_tool_call("video_import_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a media clip to the timeline")]
    async fn video_add_clip(&self, Parameters(args): Parameters<AddClipArgs>) -> String {
        self.proxy_tool_call("video_add_clip", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a text or title layer to the visible SCLIP timeline")]
    async fn video_add_text(&self, Parameters(args): Parameters<AddTextArgs>) -> String {
        self.proxy_tool_call("video_add_text", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Add a visible emoji sticker as its own overlay layer. Use a Unicode emoji such as ✨, 🔥, ❤️, 👍, 😍, or 🎉; this is for emoji stickers, not external image files."
    )]
    async fn video_add_sticker(&self, Parameters(args): Parameters<AddStickerArgs>) -> String {
        self.proxy_tool_call("video_add_sticker", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Add a native SCLIP shape layer (rectangle, circle, triangle, ellipse, star, polygon, heart, or path) to the visible timeline."
    )]
    async fn video_add_shape(&self, Parameters(args): Parameters<AddShapeArgs>) -> String {
        self.proxy_tool_call("video_add_shape", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Split a clip at a specific frame")]
    async fn video_split(&self, Parameters(args): Parameters<SplitItemArgs>) -> String {
        self.proxy_tool_call("video_split", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add a transition between two clips")]
    async fn video_add_transition(
        &self,
        Parameters(args): Parameters<AddTransitionArgs>,
    ) -> String {
        self.proxy_tool_call("video_add_transition", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Add an effect to a clip")]
    async fn video_add_effect(&self, Parameters(args): Parameters<AddEffectArgs>) -> String {
        self.proxy_tool_call("video_add_effect", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Update, toggle, or remove an existing visible SCLIP effect.")]
    async fn video_manage_effect(&self, Parameters(args): Parameters<ManageEffectArgs>) -> String {
        self.proxy_tool_call("video_manage_effect", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Trim start/end of a clip")]
    async fn video_trim(&self, Parameters(args): Parameters<TrimItemArgs>) -> String {
        self.proxy_tool_call("video_trim", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Move a clip on the timeline")]
    async fn video_move(&self, Parameters(args): Parameters<MoveItemArgs>) -> String {
        self.proxy_tool_call("video_move", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Remove clips from the timeline")]
    async fn video_remove(&self, Parameters(args): Parameters<RemoveItemsArgs>) -> String {
        self.proxy_tool_call("video_remove", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Render the project to a video file")]
    async fn video_render(&self, Parameters(args): Parameters<RenderArgs>) -> String {
        self.proxy_tool_call("video_render", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Get a compact, bounded high-level summary of the project (duration, tracks, item counts, media asset inventory, transcript and visual overview). Use this for orientation on long-form projects before requesting specific timeline windows."
    )]
    async fn video_get_project_summary(
        &self,
        Parameters(args): Parameters<GetProjectSummaryArgs>,
    ) -> String {
        self.proxy_tool_call("video_get_project_summary", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Get a bounded slice of the timeline strictly within [start_sec, end_sec]. Returns only overlapping items, sliced transcript words, visual moments, and silence ranges. Use this to inspect specific sections of long-form projects without payload explosion."
    )]
    async fn video_get_timeline_window(
        &self,
        Parameters(args): Parameters<GetTimelineWindowArgs>,
    ) -> String {
        self.proxy_tool_call("video_get_timeline_window", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Deeply inspect a specific timeline item or media segment without loading the rest of the project."
    )]
    async fn video_inspect_segment(
        &self,
        Parameters(args): Parameters<InspectSegmentArgs>,
    ) -> String {
        self.proxy_tool_call("video_inspect_segment", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Get current project state")]
    async fn video_get_project(&self, Parameters(args): Parameters<GetProjectArgs>) -> String {
        self.proxy_tool_call("video_get_project", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "List all projects in workspace")]
    async fn video_list_projects(&self, _parameters: Parameters<ListProjectsArgs>) -> String {
        self.proxy_tool_call("video_list_projects", serde_json::json!({}))
            .await
    }

    #[tool(
        description = "List the real SCLIP effect registry, transition presentations, editable Properties-panel fields, transform controls, and built-in AI workflows. Call this before using an effect, transition, or property you have not already inspected; never guess IDs or parameter names."
    )]
    async fn video_editor_capabilities(
        &self,
        _parameters: Parameters<EditorCapabilitiesArgs>,
    ) -> String {
        self.proxy_tool_call("video_editor_capabilities", serde_json::json!({}))
            .await
    }

    #[tool(
        description = "Report real SCLIP runtime capability probes: Hermes/MCP process health, captured compositor availability, local vision cache readiness, transcription, scene analysis, and render readiness. This never claims a provider is usable merely because code is installed."
    )]
    async fn video_runtime_health(&self, _parameters: Parameters<RuntimeHealthArgs>) -> String {
        self.proxy_tool_call("video_runtime_health", serde_json::json!({}))
            .await
    }

    #[tool(
        description = "Manage real SCLIP tracks. Add named video/audio tracks for primary footage, B-roll, graphics, captions, music, or voiceover; update track visibility/locking/order; or remove an empty track. Use video_get_project before and after changes."
    )]
    async fn video_manage_tracks(&self, Parameters(args): Parameters<ManageTracksArgs>) -> String {
        self.proxy_tool_call("video_manage_tracks", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Capture and inspect the actual composited SCLIP preview at a frame using the local vision-language model. Use after visual edits to review what the audience will see, including stacking, transforms, text, effects, and visible tracks."
    )]
    async fn video_review_preview(
        &self,
        Parameters(args): Parameters<ReviewPreviewArgs>,
    ) -> String {
        self.proxy_tool_call("video_review_preview", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "List media that has actually been imported into a project's SCLIP media library. Returns explicit isOnTimeline and placementCount so you never confuse imported assets with timeline clips."
    )]
    async fn video_list_media(&self, Parameters(args): Parameters<ListMediaArgs>) -> String {
        self.proxy_tool_call("video_list_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Search the active project's local media library for B-roll using only stored filenames, tags, and visual-analysis captions. Returns ranked, timestamped evidence and exact media IDs; it never downloads stock media or claims unanalysed assets depict a query."
    )]
    async fn video_search_media(&self, Parameters(args): Parameters<SearchMediaArgs>) -> String {
        self.proxy_tool_call("video_search_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Search the active project's local media library for time-indexed sub-clip visual segments using multimodal CLIP embeddings and scene semantics. Returns exact start_sec/end_sec ranges, shot types, motion levels, and calibrated semantic scores."
    )]
    async fn video_search_visual_segments(
        &self,
        Parameters(args): Parameters<SearchVisualSegmentsArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_search_visual_segments",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Inspect an imported media asset in detail, including duration, dimensions, analysis status, and exact timeline placements."
    )]
    async fn video_inspect_media(&self, Parameters(args): Parameters<InspectMediaArgs>) -> String {
        self.proxy_tool_call("video_inspect_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Resolve a compact reference copied from SCLIP, such as @sclip/item/1a2b3c4d, to the exact project, item/media/transition IDs and state. Resolve it before editing a user-referenced target."
    )]
    async fn video_resolve_reference(
        &self,
        Parameters(args): Parameters<ResolveReferenceArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_resolve_reference",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Transcribe imported media locally and persist its timestamped transcript. Call video_get_transcript afterwards when the spoken words are needed for a semantic edit."
    )]
    async fn video_transcribe(&self, Parameters(args): Parameters<TranscribeArgs>) -> String {
        self.proxy_tool_call("video_transcribe", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read a bounded, timestamped page of an existing local transcript, including word timings when available. Use it to ground talking-head cut proposals; do not invent spoken content."
    )]
    async fn video_get_transcript(
        &self,
        Parameters(args): Parameters<GetTranscriptArgs>,
    ) -> String {
        self.proxy_tool_call("video_get_transcript", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read the timeline's speech as a word-level script with stable source wordId, itemId placement, and exact source/timeline timings. Use this before proposing a talking-head edit. Pair wordId with itemId in video_apply_script."
    )]
    async fn video_read_script(&self, Parameters(args): Parameters<ReadScriptArgs>) -> String {
        self.proxy_tool_call("video_read_script", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Find grounded speech on the visible SCLIP timeline. Use kind=phrase with a query, or kind=filler for unambiguous hesitation sounds. Returns stable word references; this never edits the timeline."
    )]
    async fn video_find_speech(&self, Parameters(args): Parameters<FindSpeechArgs>) -> String {
        self.proxy_tool_call("video_find_speech", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Preview or apply a transcript-script edit. Currently supports remove_words using stable { item_id, word_id } references returned by video_read_script/video_find_speech. Call first without confirm to inspect exact ranges and scriptRevision; only confirm=true with expected_revision set to that scriptRevision performs FreeCut's deterministic split/remove/ripple operation, which remains undoable and rejects stale placements."
    )]
    async fn video_apply_script(&self, Parameters(args): Parameters<ApplyScriptArgs>) -> String {
        self.proxy_tool_call("video_apply_script", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Save, list, inspect, preview, or safely apply a SCLIP rough-cut proposal. A proposal is project-local and must include a summary, a scriptRevision returned by video_read_script, and reviewable remove_words operations using stable word references. preview_apply never changes the timeline. apply requires confirm=true and the same expected_revision, creates a named project recovery snapshot, then performs undoable FreeCut transcript edits."
    )]
    async fn video_rough_cut_proposal(
        &self,
        Parameters(args): Parameters<RoughCutProposalArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_rough_cut_proposal",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Return a bounded, revision-bound editorial evidence bundle for one objective. It joins existing script, source visual observations, semantic-map candidates, timeline summary, and explicit creator context without dumping the project or full transcript. Candidates are evidence for Hermes to judge, never automatic cut instructions."
    )]
    async fn video_get_editorial_evidence(
        &self,
        Parameters(args): Parameters<EditorialEvidenceArgs>,
    ) -> String {
        self.proxy_tool_call("video_get_editorial_evidence", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Retrieve small, versioned SCLIP editing principles for the supplied topics. This is deterministic reference retrieval, not an editorial planner or a giant system prompt."
    )]
    async fn video_get_editing_guidance(
        &self,
        Parameters(args): Parameters<EditingGuidanceArgs>,
    ) -> String {
        self.proxy_tool_call("video_get_editing_guidance", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Save, list, inspect, validate, preview, or execute a general SCLIP edit plan. Hermes is the sole planner. V1 executes only approved deterministic FreeCut operations, validates evidence/revision/args before mutation, creates a recovery snapshot, and returns deterministic plus perceptual verification."
    )]
    async fn video_edit_plan(&self, Parameters(args): Parameters<EditPlanArgs>) -> String {
        self.proxy_tool_call("video_edit_plan", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Record, list, or reset project-scoped structured creator corrections to SCLIP plan operations. Corrections are local learning data, not commands to replay edits automatically in another project."
    )]
    async fn video_correction_event(
        &self,
        Parameters(args): Parameters<CorrectionEventArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_correction_event",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Build and persist SCLIP's grounded semantic map for one imported source asset. It joins existing timestamped transcript and source-footage visual analysis into review candidates such as fillers, repeated lines, and speech gaps; it never cuts automatically. Run video_transcribe and video_understand first when evidence is missing."
    )]
    async fn video_build_semantic_map(
        &self,
        Parameters(args): Parameters<BuildSemanticMapArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_build_semantic_map",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(description = "Analyze video content with AI")]
    async fn video_understand(&self, Parameters(args): Parameters<UnderstandArgs>) -> String {
        self.proxy_tool_call("video_understand", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Update a real timeline item's text style, audio settings, speed, fades, visibility, or other supported SCLIP item fields."
    )]
    async fn video_update_item(&self, Parameters(args): Parameters<UpdateItemArgs>) -> String {
        self.proxy_tool_call("video_update_item", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Update a real timeline item's transform: position, size, rotation, opacity, scale, or anchor."
    )]
    async fn video_update_transform(
        &self,
        Parameters(args): Parameters<UpdateTransformArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_update_transform",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(description = "Add a numeric animation keyframe to a real SCLIP timeline item.")]
    async fn video_add_keyframe(&self, Parameters(args): Parameters<AddKeyframeArgs>) -> String {
        self.proxy_tool_call("video_add_keyframe", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Update or remove an existing visible SCLIP transition.")]
    async fn video_manage_transition(
        &self,
        Parameters(args): Parameters<ManageTransitionArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_manage_transition",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Perform a real native timeline edit: ripple delete, reverse, close a gap, set/clear in-out, or rate stretch."
    )]
    async fn video_timeline_edit(&self, Parameters(args): Parameters<TimelineEditArgs>) -> String {
        self.proxy_tool_call("video_timeline_edit", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Analyze real audio/speech gaps for selected timeline items without editing them. signal mode reads decoded waveform; speech mode uses the local timestamped transcript. It returns source-time silence candidates and limitations. Review the result, then use FreeCut's normal timeline edit with explicit approval; never treat a transcript gap as silence by itself."
    )]
    async fn video_analyze_audio(&self, Parameters(args): Parameters<AnalyzeAudioArgs>) -> String {
        self.proxy_tool_call("video_analyze_audio", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Undo or redo a visible SCLIP timeline change using the editor's real history, then save the restored project."
    )]
    async fn video_history(&self, Parameters(args): Parameters<HistoryArgs>) -> String {
        self.proxy_tool_call("video_history", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Generate/cancel a real SCLIP proxy for video media, or relink missing media from an absolute replacement file path."
    )]
    async fn video_manage_media(&self, Parameters(args): Parameters<ManageMediaArgs>) -> String {
        self.proxy_tool_call("video_manage_media", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read or update SCLIP-only editing preferences and feedback. This is isolated to SCLIP and never accesses the user's separate personal-agent memory."
    )]
    async fn video_editing_memory(
        &self,
        Parameters(args): Parameters<EditingMemoryArgs>,
    ) -> String {
        self.proxy_tool_call("video_editing_memory", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Create, list, or restore persistent SCLIP project recovery snapshots. Restore is destructive and should be confirmed unless explicitly requested."
    )]
    async fn video_project_snapshot(
        &self,
        Parameters(args): Parameters<ProjectSnapshotArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_project_snapshot",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }

    #[tool(
        description = "Generate local MusicGen music or Kokoro speech, import it into the visible SCLIP media library, and optionally insert an editable audio clip."
    )]
    async fn video_generate_audio(
        &self,
        Parameters(args): Parameters<GenerateAudioArgs>,
    ) -> String {
        self.proxy_tool_call("video_generate_audio", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Run SCLIP's local scene detection on a visible video clip, persist the results for the Scene Browser, and optionally split that real timeline clip at cuts."
    )]
    async fn video_detect_scenes(&self, Parameters(args): Parameters<DetectScenesArgs>) -> String {
        self.proxy_tool_call("video_detect_scenes", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(description = "Inspect a render job's actual queue progress, or cancel one by id.")]
    async fn video_render_status(&self, Parameters(args): Parameters<RenderStatusArgs>) -> String {
        self.proxy_tool_call("video_render_status", serde_json::to_value(args).unwrap())
            .await
    }

    #[tool(
        description = "Read-only SCLIP preflight for the live project. Reports missing media, unintended same-track overlaps, locked/hidden tracks, empty projects, and render readiness. Run before a multi-step edit and immediately before rendering."
    )]
    async fn video_validate_project(
        &self,
        Parameters(args): Parameters<ValidateProjectArgs>,
    ) -> String {
        self.proxy_tool_call(
            "video_validate_project",
            serde_json::to_value(args).unwrap(),
        )
        .await
    }
}

impl ServerHandler for SocketMcpServer {
    fn get_info(&self) -> InitializeResult {
        InitializeResult {
            protocol_version: ProtocolVersion::default(),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "sclip".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            instructions: None,
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tool_router.list_all(),
            next_cursor: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self.tool_router
            .call(ToolCallContext::new(self, request, context))
            .await?;
        Ok(mark_proxy_error_result(result))
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn marks_proxy_error_envelopes_as_mcp_errors() {
        let error = mark_proxy_error_result(CallToolResult::success(vec![Content::text("ERROR: Unknown tool: demo")]));
        let success = mark_proxy_error_result(CallToolResult::success(vec![Content::text("OK: {\"success\":true}")]));
        assert_eq!(error.is_error, Some(true));
        assert_eq!(success.is_error, Some(false));
    }
}

/// Initialize and start the MCP server in standalone mode (no GUI, stdio transport)
/// This mode is used when Hermes spawns `freecut --mcp-server` as an MCP subprocess.
/// The server registers all tool schemas and proxies tool calls to the GUI process
/// via the Unix socket at SOCKET_PATH.
pub async fn start_mcp_server_standalone() -> anyhow::Result<()> {
    // Initialize structured logging
    init_logging();

    log::info!(
        "[Sclip] Standalone MCP server mode — connecting to Unix socket {}",
        SOCKET_PATH
    );

    let server = SocketMcpServer::new();
    let transport = (tokio::io::stdin(), tokio::io::stdout());

    // Serve the stdio JSON-RPC server (tools/list, tools/call, etc.)
    // This blocks until the transport is closed by the client
    log::info!("[Sclip] Starting rmcp serve_server...");
    let result = rmcp::service::serve_server(server, transport).await;
    match result {
        Ok(running) => {
            // Keep the service alive for tools/list and tools/call.  `rmcp`
            // returns after the initialize/initialized handshake; its
            // RunningService owns the actual request-processing task.
            match running.waiting().await {
                Ok(reason) => log::info!("[Sclip] MCP server transport closed: {:?}", reason),
                Err(e) => log::warn!("[Sclip] MCP request loop ended unexpectedly: {:?}", e),
            }
        }
        Err(e) => {
            log::error!("[Sclip] MCP server error: {:?}", e);
            return Err(e.into());
        }
    }

    Ok(())
}

/// Start the Unix socket listener that bridges between the MCP proxy process
/// and the GUI webview. Called from lib.rs setup.
///
/// When a tool call arrives via socket:
/// 1. Emit 'sclip-tool-call' Tauri event to the webview
/// 2. Webview dispatches via sclip-mcp-bridge.ts → Zustand → invoke('handle_tool_result')
/// 3. handle_tool_result sends the result through the oneshot channel
/// 4. The socket handler sends the result back to the MCP proxy process
pub async fn start_mcp_socket_server(app_handle: tauri::AppHandle) -> anyhow::Result<()> {
    // Remove stale socket file if it exists
    let _ = tokio::fs::remove_file(SOCKET_PATH).await;

    // Bind the Unix socket
    let listener = tokio::net::UnixListener::bind(SOCKET_PATH)?;

    eprintln!(
        "[Sclip] Unix socket MCP bridge listening on {}",
        SOCKET_PATH
    );

    // Set socket permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(SOCKET_PATH) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o666);
            let _ = std::fs::set_permissions(SOCKET_PATH, perms);
        }
    }

    let app_handle_for_listener = app_handle.clone();

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((socket, _addr)) => {
                    eprintln!("[Sclip DIAG] Socket accepted a connection");
                    let app_handle = app_handle_for_listener.clone();
                    tokio::spawn(async move {
                        handle_socket_connection(socket, app_handle).await;
                    });
                }
                Err(e) => {
                    eprintln!("[Sclip] Socket accept error: {}", e);
                }
            }
        }
    });

    Ok(())
}

async fn handle_socket_connection(socket: tokio::net::UnixStream, app_handle: tauri::AppHandle) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (reader, mut writer) = socket.into_split();
    let mut buf_reader = BufReader::new(reader);

    loop {
        let mut line = String::new();
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break, // Connection closed
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match serde_json::from_str::<SocketMessage>(trimmed) {
                    Ok(SocketMessage::ToolCall { id, tool, args }) => {
                        eprintln!("[Sclip DIAG] handle_socket_connection: received ToolCall id={} tool={}", id, tool);
                        let call_id = id.clone();

                        // Create oneshot channel for this request
                        let (tx, rx) = oneshot::channel();

                        // Store the sender in the pending map
                        {
                            let mut pending = PENDING_REQUESTS.lock().await;
                            pending.insert(call_id.clone(), tx);
                            eprintln!("[Sclip DIAG] handle_socket_connection: inserted into PENDING_REQUESTS count={}", pending.len());
                        }

                        // Emit the tool call to the webview
                        let emit_result = app_handle.emit(
                            TOOL_CALL_EVENT,
                            serde_json::json!({
                                "id": call_id,
                                "tool": tool,
                                "args": args,
                            }),
                        );
                        let _ = app_handle.emit_to(
                            "main",
                            TOOL_CALL_EVENT,
                            serde_json::json!({
                                "id": call_id,
                                "tool": tool,
                                "args": args,
                            }),
                        );
                        eprintln!(
                            "[Sclip DIAG] handle_socket_connection: emit result={:?}",
                            emit_result
                        );

                        // Wait for the result via oneshot receiver (300s for ML perception, 60s otherwise)
                        let timeout_secs = match tool.as_str() {
                            "video_generate_audio"
                            | "video_understand"
                            | "video_transcribe"
                            | "video_detect_scenes"
                            | "video_analyze_audio"
                            | "video_review_preview" => 300,
                            _ => 60,
                        };
                        let result =
                            tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await;
                        eprintln!(
                            "[Sclip DIAG] handle_socket_connection: oneshot result={:?}",
                            result.as_ref().map(|r| r.is_ok())
                        );

                        // Clean up if still pending
                        {
                            let mut pending = PENDING_REQUESTS.lock().await;
                            pending.remove(&call_id);
                        }

                        let response = match result {
                            Ok(Ok(result)) => SocketMessage::ToolResult {
                                id: call_id,
                                result: result.result,
                                is_error: result.is_error,
                            },
                            Ok(Err(_)) => SocketMessage::ToolResult {
                                id: call_id,
                                result: Value::String("Channel closed".into()),
                                is_error: true,
                            },
                            Err(_) => SocketMessage::ToolResult {
                                id: call_id,
                                result: Value::String("Timeout".into()),
                                is_error: true,
                            },
                        };

                        // Send the response back through the socket
                        let response_json = serde_json::to_string(&response).unwrap_or_default();
                        eprintln!(
                            "[Sclip DIAG] handle_socket_connection: sending response: {}",
                            response_json
                        );
                        let _ = writer.write_all(response_json.as_bytes()).await;
                        let _ = writer.write_all(b"\n").await;
                        let _ = writer.flush().await;
                    }
                    Err(e) => {
                        eprintln!("[Sclip] Socket parse error: {}", e);
                    }
                    _ => {} // Ignore ToolResult messages on incoming
                }
            }
            Err(e) => {
                eprintln!("[Sclip] Socket read error: {}", e);
                break;
            }
        }
    }
}

#[tauri::command]
pub async fn handle_tool_result(
    _app_handle: tauri::AppHandle,
    call_id: Option<String>,
    #[allow(non_snake_case)] callId: Option<String>,
    result: serde_json::Value,
    is_error: Option<bool>,
    #[allow(non_snake_case)] isError: Option<bool>,
) -> Result<(), String> {
    let id = call_id
        .or(callId)
        .ok_or_else(|| "Missing call_id".to_string())?;
    let error = is_error.or(isError).unwrap_or(false);
    let tool_result = SclipToolResult {
        id: id.clone(),
        result,
        is_error: error,
    };

    eprintln!("[Sclip DIAG] handle_tool_result: received call_id={}", id);
    let mut pending = PENDING_REQUESTS.lock().await;
    if let Some(tx) = pending.remove(&id) {
        eprintln!("[Sclip DIAG] handle_tool_result: found pending request, sending result");
        let _ = tx.send(tool_result);
        Ok(())
    } else {
        eprintln!(
            "[Sclip DIAG] handle_tool_result: NO pending request for call_id={}",
            id
        );
        Err("No pending request for call_id".to_string())
    }
}
