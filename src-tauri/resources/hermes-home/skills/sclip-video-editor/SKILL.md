---
name: sclip-video-editor
description: Control the active SCLIP video editor through MCP.
version: 1.0.0
author: SCLIP
platforms: [macos]
metadata:
  hermes:
    category: creative
    tags: [video, editing, sclip]
---

# SCLIP Video Editor Skill

Use the `sclip-editor` MCP server to inspect and edit the project that is open
in SCLIP. This skill coordinates real editor state; it does not introduce a
second timeline or an invisible rendering backend.

Read `references/editing-playbook.md` before planning a creative edit. It is
the shared SCLIP baseline; explicit user instructions and confirmed per-user
editing preferences always take priority.

For a reusable talking-head/interview delivery run, follow
`references/talking-head-delivery.md` in addition to this skill. It binds the
semantic proposal, user review, captions, composed preview, and export checks
into one safe end-to-end workflow.

## When to Use

Use this skill whenever the user asks to create, change, inspect, preview, or
render a video in SCLIP.

## Prerequisites

- The SCLIP desktop app is open.
- The `sclip-editor` MCP server is available in the current session.
- Required media is already associated with the project, unless an import tool
  is available.

When the user attaches an image, video, or audio file to the chat, treat the
attachment path supplied by SCLIP as an import source. Call
`video_import_media` with that path, then `video_list_media`; do not search
the workspace filesystem or hand-edit project files to make the attachment
appear.

## How to Run

1. Identify the project that is actually open. `video_list_projects` returns
   `activeProjectId` and `isOpenInEditor`; use those fields. Never infer
   “current” from timestamps. If no project is open, ask the user which one
   they intend to edit.
2. Call `video_get_project` first. Its `timeline` is the live editor
   storyboard: tracks, order, items, timing, effects, transitions, keyframes,
   markers, and canvas. Never plan from a project list alone.
3. For an editorial or multi-step edit, call `video_get_editorial_evidence`
   with the concrete objective, then `video_get_editing_guidance` for only the
   relevant principles, and inspect `video_editing_memory`. Hermes remains
   SCLIP's single general planner: specialist tools provide evidence while
   Hermes creates one revision-bound `video_edit_plan`. Include evidence IDs,
   risks, and deterministic/perceptual/editorial verification. Call
   `video_edit_plan` with `action: "preview"` before destructive execution,
   then `action: "execute"`, `confirm: true`, and the preview's live revision.
   Small direct deterministic requests (for example moving one known clip) may
   continue to use the existing direct mutation tool.
3. Choose evidence based on the request. For talking-head, interview, podcast,
   or other speech-led cleanup, begin with `video_transcribe`,
   `video_read_script`, and `video_find_speech`; do not make a full visual
   analysis a prerequisite. Use `video_understand` only when a visual decision
   is required: choosing between takes by appearance, finding an object/action,
   selecting B-roll, or checking whether a graphic covers a subject.
4. Call `video_editor_capabilities` before using an effect, transition, or
   Properties-panel field you have not already inspected. Use returned exact
   IDs and parameter names; never guess them from a UI label.
5. Before building a multi-layer edit, design the track stack explicitly:
   primary footage, B-roll, graphics, captions, music, and voiceover must
   have intentional lanes. Use `video_manage_tracks` to add and name tracks;
   never stack unrelated visual layers on the primary footage track just
   because it is available.
6. Call `video_validate_project` before a multi-step edit. Resolve errors
   first; treat warnings such as same-track overlaps as deliberate creative
   choices, never as something to ignore.
7. For a speech-led edit, propose a script plan first. Ground it in stable
   `{ wordId, itemId }` references returned by `video_read_script` or
   `video_find_speech`, state what would be removed/compressed/reordered and
   why, and wait for approval unless the user explicitly requested the exact
   destructive cleanup. Use `video_apply_script` without `confirm` to show
   its precise preview and `scriptRevision`; use `confirm: true` only after
   approval and pass that preview's revision as `expected_revision`. Do not
   make the model calculate split frames or perform raw timeline surgery itself.
8. For visual and structural work outside a speech edit, translate the request
   into small timeline operations using returned IDs and actual frame positions.
   Call only tools exposed by `sclip-editor`.
9. After every structural edit, call `video_get_project` again. Its returned
   placement is authoritative; do not continue with planned offsets if a clip
   landed somewhere else.
10. After visually meaningful changes, call `video_review_preview` at the
   hook, a representative middle frame, and the ending. It captures the real
   composited SCLIP preview and asks the local vision model what is visible.
   Correct collisions, unreadable text, blocked subjects, or ugly layering
   before rendering.
11. Render only after the live timeline matches the request and
    `video_validate_project` with `mode: "render"` has no errors.

## Quick Reference

- Use `video_list_projects` to discover real project IDs.
- Use `video_get_project` to inspect the live timeline state. It is the
  agent's basic editor view: track order, group/sequence structure, item
  placement, duration, effects, transitions, keyframes, and markers.
- Use `video_validate_project` as a read-only preflight before a batch edit
  and immediately before rendering. It catches missing media, same-track
  collisions, locked/hidden/muted populated tracks, and empty timelines.
- Use `video_editor_capabilities` as the authoritative catalogue of SCLIP
  effects, transitions, Property-panel fields, transform controls, and AI
  features. It prevents invalid effect IDs and transition parameters.
- Use `video_manage_tracks` to create named video/audio tracks and control
  their order, visibility, locking, mute, solo, and volume. Keep the primary
  story on its own lane; B-roll can cover it only intentionally; captions and
  graphics need their own visible overlay lanes; music and voiceover need
  separate audio lanes. Never remove a non-empty track.
- Use `video_list_media` before `video_add_clip`. It returns the actual
  imported-media IDs; never guess an ID from a filename or scan project files.
- Use `video_search_media` to find local B-roll candidates. It ranks only
  stored filename, tag, and existing visual-caption evidence and returns the
  exact matching timestamp/thumbnail when one exists. It does not download
  stock footage or prove that an unanalysed asset depicts the requested idea;
  run `video_understand` before a content-dependent placement when needed.
- A pasted `@sclip/item/...`, `@sclip/media/...`, or `@sclip/transition/...`
  is an explicit user-selected target. Call `video_resolve_reference` first,
  then use the returned exact IDs. Do not re-identify the target or ask the
  user to choose it again.
- Use timeline mutation tools only with IDs returned by the editor.
- Use `video_update_item` for real text styling, audio gain/fades/ducking,
  playback speed, clip fades, and visible/locked state. Never write project
  files directly.
- Use `video_update_transform` and `video_add_keyframe` for position, scale,
  zoom, rotation, opacity, and animation.
- Use `video_add_effect` only with an effect id and params returned from
  `video_editor_capabilities`. It updates the visible clip effect stack.
- Use `video_add_transition` only between the exact compatible clip IDs
  returned by the live timeline. Its `transition_type` is the GPU presentation
  ID returned by `video_editor_capabilities` (such as `dissolve` or `fade`),
  not a guessed generic type.
- Use `video_manage_effect` to adjust, toggle, or remove an existing effect
  after resolving the target item/reference.
- Use `video_manage_transition` to update or remove a copied transition.
- Use `video_add_shape` for native SCLIP shapes; use `video_update_item`,
  `video_update_transform`, and keyframes to style and animate them.
- Use `video_timeline_edit` for ripple deletion, reversing, gap closing,
  in/out ranges, rate stretching, and applying user-approved silence/filler
  ranges. Analysis ranges must come from SCLIP/transcript results; never
  invent cuts from a guess.
- Use `video_manage_media` to generate/cancel SCLIP proxies or relink a
  missing source. These are project-library actions, not hidden copies.
- Use `video_generate_audio` for local background music or synthetic narration.
  It imports the result into the project and, by default, inserts an editable
  audio clip. State clearly that it is AI-generated; do not claim a real
  microphone recording was made.
- Use `video_history` for requested undo/redo. It shares the human editor's
  history, then persists the restored project.
- Use `video_get_editorial_evidence` to retrieve a bounded, provenance-aware
  editorial view. It does not dump a full project or transcript and explicitly
  labels unavailable audio/visual evidence.
- Use `video_get_editing_guidance` with only relevant topics (`hook`,
  `short_form_structure`, `dialogue_editing`, `pacing`, `repetition`, or
  `ending_payoff`). It returns principles, not editorial judgement.
- Use `video_edit_plan` for an editorial or multi-operation job. It validates
  evidence, revision, dependencies, allowed executors, and arguments before
  execution; preview before any destructive plan execution. If revision
  changes, gather fresh evidence and create a new plan instead of applying
  stale assumptions.
- Use `video_correction_event` when the creator accepts, rejects, modifies,
  or undoes a proposed operation. Store compact structured facts such as
  `{ "preference": "slower_caption_pacing" }`, never credentials, raw
  private media, or hidden reasoning. Read correction events as hints for the
  current project; do not blindly replay them elsewhere.
- Start a meaningful edit by calling `video_editing_memory` with `get` and
  apply only preferences relevant to the request. Record an explicit style
  preference or correction with `update_preferences` / `record_feedback`; do
  not infer a permanent preference from one unconfirmed edit.
- Treat SCLIP editing memory as a narrow, on-device companion to Hermes's own
  conversational memory: use durable named fields such as `captionStyle`,
  `pacing`, `musicMood`, `colors`, and `effects`, plus project-specific context
  such as a client brief. Never put credentials, raw private media, or a hidden
  chain-of-thought into it. When a preference is uncertain, ask or keep it as
  a one-project note instead of making it global.
- Before a multi-step or destructive edit, create a named
  `video_project_snapshot`. If a step fails, stop and offer the latest
  snapshot rather than guessing how to repair the timeline. Restoring one
  requires explicit user confirmation unless the user directly asked for it.
- Use `video_transcribe` with an imported media id. Set `caption_mode` to
  `items` for editable caption layers or `virtual` for linked captions.
- Use `video_read_script` for the canonical talking-head/interview editing
  surface. Its stable `wordId` is source evidence and `itemId` identifies the
  visible timeline placement. Use `video_find_speech` for a phrase or for
  unambiguous hesitation sounds (`um`, `uh`, `erm`, `ah`).
- Use `video_build_semantic_map` after transcription and, where needed,
  source visual analysis. It is derived evidence, not authoritative timeline
  state; its candidates are never approved cuts by themselves. Treat
  `filler_language`, exact repetition/retake candidates, topic transitions,
  hook heuristics, CTAs, and low-confidence words as differently grounded
  evidence. `speech_gap` explicitly requires audio verification; it is not
  permission to remove silence.
- Use `video_apply_script` for a small, directly requested transcript-driven removal. Always call it
  first without `confirm` to inspect source/timeline ranges and capture the
  returned `scriptRevision`, then call it with `confirm: true` and
  `expected_revision: <scriptRevision>` only when the user has approved the
  plan or directly asked for that exact cleanup. It uses FreeCut's native
  split/remove/ripple command, rejects stale placements, and remains undoable
  through `video_history`.
- Use `video_rough_cut_proposal` for a meaningful talking-head rough cut.
  First save a structured proposal grounded in the `scriptRevision` from
  `video_read_script`; it must contain a concise summary and explicit
  `remove_words` operations. Then call `preview_apply`, present the precise
  preview to the user, and call `apply` only with explicit approval,
  `confirm: true`, and that preview's `expected_revision`. Application creates
  a named recovery snapshot before using the same native undoable edit path.
- Use `video_understand` with a video or image media id before a decision that
  depends on what it looks like. SCLIP's local vision-language pipeline sees
  sampled frames and returns real timestamped descriptions, subjects, actions,
  setting, lighting, palettes, and captured-frame paths. It is selective visual
  evidence, not a required first step for transcript-led speech editing.
- Use `video_review_preview` after composing. It is the final-composition
  vision path: it seeks the actual SCLIP preview to a chosen project frame,
  captures the composited canvas, and analyzes those pixels locally. Use it
  to check the audience-facing result, not just individual source clips.
- Use `video_transcribe` to create the transcript/caption workflow in SCLIP's
  AI panel, then use `video_read_script` for placement-aware word evidence.
  Use `items` for editable captions and `virtual` for linked captions. Use
  transcript timings before silence/filler removal or proposing a talking-head
  rough cut.
- Use `video_detect_scenes` to access Scene Browser-style AI cuts. It returns
  boundaries first; only split automatically when the user asked for it.
- Use `video_update_item`, `video_update_transform`, `video_add_keyframe`,
  `video_add_effect`, and `video_manage_effect` as the Properties-panel
  controls. Re-read the item in the live timeline after changing properties.
- Use `video_detect_scenes` on a real video timeline item when scene-aware
  cuts are requested. Set `split` only when the user requested automatic
  cutting; otherwise return the detected scene boundaries for review.
- Use `video_render` after state verification, then poll `video_render_status`
  until the job is completed, failed, or cancelled. Prefer the `recommended`
  preset unless the user asks for smaller files, a maximum-quality master, or
  an explicit codec/container/subtitle mode.
- Use `video_add_sticker` for emoji stickers. For a request such as "add some
  stickers," add 2–3 small, non-obstructive emoji overlays (for example ✨,
  🔥, and ❤️) on separate tracks; do not ask the user to supply files unless
  they specifically want image stickers.

The MCP tool list is authoritative. Report a failed analysis plainly instead
of claiming success or substituting a hidden workflow.

## Procedure

### Plan

Summarize the intended duration, structure, media, text, audio, and styling.
Keep the plan short enough that the user can follow changes in the GUI.
State what is known from media/transcript analysis and what is a creative
proposal. Never invent a hook, highlight, or factual claim without examining
the source footage.

### Speech-led rough-cut workflow

For talking heads and interviews, use this exact order:

1. Transcribe the source if required, then call `video_read_script`.
2. Use `video_find_speech` for a requested phrase or unambiguous fillers. Use
   transcript semantics to identify retakes, repeated ideas, tangents, a hook,
   and key claims, but describe uncertain judgements as review candidates.
3. Build and save a concise `video_rough_cut_proposal`: goal, retained
   structure, explicitly grounded word ranges to remove, expected duration
   change, and limitations. The current safe executor supports removal-based
   tightening; do not claim it reordered or rewrote footage.
4. Call `video_rough_cut_proposal` with `preview_apply`, show the user the
   exact ranges, then apply only approved removals with `confirm: true` and the
   returned `scriptRevision` as `expected_revision`. Re-read the live project
   after each structural operation because ripple changes all later positions.
5. Use actual silence analysis for pause work; a gap between transcript words
   is not proof of silence. Compress pauses rather than reducing every gap to
   zero, and preserve breaths, emotional beats, and topic changes.
6. Generate captions from this same transcript after the structural cut is
   stable. Do not make a second, unrelated timing system.

### Edit

Perform one logical mutation at a time. Use frame values consistent with the
project FPS. Preserve existing timeline items unless removal is requested or
clearly necessary for the goal. For generated layers, trust the returned
`fromFrame`, `durationFrames`, and `trackId`: SCLIP may move an item to the
next free compatible track or gap. Re-inspect before placing dependent items.

### Verify

Read project state after structural operations. Confirm item IDs, tracks,
start frames, durations, track occupancy, and render status from tool results.
If a result differs from the intended structure, stop and correct it before
adding more edits.
For any edit with overlapping layers, inspect at least the opening, a frame
where each graphic/caption first appears, and the ending with
`video_review_preview`. If the visual analysis says a subject is obscured or
the composition is unclear, adjust transforms/timing/track visibility before
continuing.
After a user accepts or corrects a result, preserve the explicit feedback in
SCLIP's editing memory so future edits improve without changing the user's
personal agent memory.

Before claiming an edit is finished: run `video_validate_project` in render
mode, confirm the project is saved, and distinguish a queued render from a
completed render.

### Correct

If a tool returns an error, stop the dependent sequence. Re-read state and
repair the first failed boundary rather than continuing with assumed state.
For a destructive sequence (remove, ripple deletion, silence/filler removal,
or a broad restyle), first state the affected clips and ask for confirmation
unless the user explicitly requested that exact destructive edit.

## Pitfalls

- Do not call tools remembered from an older SCLIP plugin.
- Do not use terminal commands to rewrite `project.json`.
- Do not claim success from a queued render alone; distinguish queued,
  running, completed, and failed states.
- Do not make background-only edits that bypass the visible editor timeline.

## Verification

The task is complete when the editor state reflects the requested edit, the
GUI and persisted project agree, and any requested render completes at the
expected path.
