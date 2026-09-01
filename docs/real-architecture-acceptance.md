# SCLIP reliability acceptance

This document deliberately separates deterministic proof from the actual desktop
runtime. A green unit or headless test must not be described as a successful
Hermes, model-provider, compositor, or native-app test.

## Command classes

| Class | Command | What it proves | What it does not prove |
| --- | --- | --- | --- |
| UNIT | `npm run acceptance:unit` | Revision/evidence and media-service contracts under Vitest | Tauri, Hermes, real pixels, model provider |
| INTEGRATION | `npm run acceptance:integration` | Browser/headless edit, save, reopen and render contracts | Installed SCLIP.app or Hermes gateway |
| DESKTOP-RUNTIME | `npm run acceptance:desktop -- --app /Applications/SCLIP.app` | Starts the manual installed-app checklist only | It is not an unattended desktop assertion |
| REAL-MODEL | `SCLIP_REAL_MODEL_ACCEPTANCE=1 npm run acceptance:real-model -- --app /Applications/SCLIP.app` | Explicitly-authorized manual provider run | Normal CI; it must never run automatically |

Without `SCLIP_REAL_MODEL_ACCEPTANCE=1`, the last command must print
`REAL_MODEL_TEST_SKIPPED` and make no provider request.

## Desktop-runtime procedure

Use a disposable project and record the exported SCLIP diagnostic ledger for
each failure. Before beginning, open SCLIP, establish chat, and call
`video_runtime_health`. Its process diagnostic is the authoritative list of
the GUI, Hermes, watchdog, and MCP PIDs owned by this app context.

1. Repeat ten times: launch SCLIP, open the project, establish chat, record
   `video_runtime_health`, close SCLIP, then verify every PID listed in that
   invocation has exited. Do not use global name-based process killing: other
   Hermes installations are outside this test's ownership.
2. Reopen the project and perform add, move, trim, split, remove, undo, redo,
   save, and reopen. Confirm the same visible timeline survives reopening.
3. Through chat, call `video_get_project` and retain revision A. Make a manual
   timeline change to produce B. Submit a mutation with A and verify the MCP
   result is the structured object `{ code: "REVISION_MISMATCH", expected: A,
   actual: B, operation: ... }` and that the timeline remains B. Repeat using
   B and confirm the edit succeeds; read the resulting C with
   `video_get_project`.
4. Confirm bad arguments, missing media, locked tracks, unavailable vision,
   and unavailable provider fail without a React crash, project corruption, or
   false success. Use `video_runtime_health` rather than assuming availability.
5. Test a real H.264 MP4, supported MOV, and image independently. For each,
   preserve the frame artifact and require provenance with
   `pixelsCaptured=true`, `pixelsAnalyzed=true`, and
   `semanticVisionPerformed=true` before stating any visual conclusion. If
   vision returns degraded, its text must say “I could not visually inspect
   the pixels.”
6. Review a composited preview. Its evidence ID must be scoped to the current
   `projectRevision`; make any timeline change and confirm the prior review is
   stale. In contrast, source evidence remains current through timeline-only
   changes and becomes invalid after relinking/replacing its asset.

## Explicit real-model procedure

Only after a developer intentionally configures the provider and accepts any
cost/data policy, set `SCLIP_REAL_MODEL_ACCEPTANCE=1`. In the disposable
desktop project, send a bounded prompt that asks Hermes to: read the project,
perform one `expected_revision`-guarded text edit, then report the changed
project revision. Verify the trace contains the actual chain:

```text
SCLIP chat → Hermes → MCP → Unix socket → Tauri event → sclip-mcp-bridge → Zustand timeline → project.json
```

Save the tool trace and before/after project revisions. A configuration check,
mock response, or unit test is not a real-model result.
