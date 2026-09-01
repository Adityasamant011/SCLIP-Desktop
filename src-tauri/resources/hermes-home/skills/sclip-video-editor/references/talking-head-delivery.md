# SCLIP Talking-Head Delivery Workflow

Use this reusable workflow when the user asks to turn a spoken recording into
a tighter, captioned, ready-to-post edit. It is a guarded operating procedure,
not an automatic deletion preset.

1. Inspect the live project and its media. Transcribe the selected source if
   needed, then read the placement-aware word script.
2. Build the semantic map. Separate source evidence (filler words, exact
   repeated lines, confidence, and speech gaps) from editorial suggestions
   (retakes, topic shifts, hook, tangents, and key claims).
3. Create a rough-cut proposal tied to the returned script revision. The first
   SCLIP executor may remove grounded word ranges only; it must not invent a
   new order, transcript, or claim.
4. Show the summary and exact ranges. Preview the proposal before applying it.
   Apply only after the user approves; SCLIP creates a recovery snapshot and
   uses the regular undoable FreeCut operation.
5. Re-read the live timeline after the ripple edit. Generate captions only
   once the cut is stable and check names, numbers, and timing.
6. Use local-media search only for evidence-backed B-roll candidates. Ask
   before placing a candidate unless the user explicitly requested placement.
7. Review the captured composited preview at the opening, a representative
   middle, and the ending. State whether pixels were actually analysed or only
   structural compositor telemetry was available.
8. Run project validation before rendering. Queue the render, poll its status,
   and report the actual output state instead of declaring success early.

If a requested step lacks transcript, visual, or audio evidence, say so and
offer the next available analysis step. Never substitute a model guess for
editor state or media evidence.
