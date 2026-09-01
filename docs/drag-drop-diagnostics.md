# SCLIP Drag-Drop Deep Diagnostic Report

## Date: 2026-08-22

## Architecture Overview

### Project Structure
- **Root**: `/Users/adityasamant/SCLIP/freecut`
- **Frontend**: React + TypeScript (Vite), Zustand for state management
- **Backend**: Rust via Tauri commands (`src-tauri/src/lib.rs`)
- **Storage**: OPFS (origin-private file system) + File System Access API handles
- **Build**: Tauri + Vite, Electron-free, native WebView

### Two Timeline Systems
1. **Classic Timeline (Sequence Editor)**: `features/timeline/components/timeline.tsx` → `TimelineContent` → `TimelineTrack` + `TimelineMediaDropZone`
   - Renders when `workspace !== 'motion'` (default/editor/color/animate workspaces)
   - Handles `editorKind: 'sequence'` compositions
   - Default active composition: `null` (Main Timeline, sequence type)

2. **Compositing Timeline (Motion Workspace)**: `features/editor/components/compose-workspace/compositing-timeline.tsx`
   - Renders only when `workspace === 'motion'` AND `composition.editorKind === 'composite-2d'`
   - Layer/property-based editor (After Effects-like)

## Drag-Drop Pipeline

### Internal Drag (from media sidebar)
```
media-card.tsx:onDragStart
  → setMediaDragData({type: 'media-item' | 'media-items', ...})
  → dataTransfer.setData('application/json', JSON.stringify(dragData))
  → body timeline-external-media-drag class (disables pointer-events on clips)

TimelineTrack.handleDrop OR TimelineMediaDropZone.handleDrop
  → getMediaDragData() OR e.dataTransfer.getData('application/json')
  → resolveDroppedMediaEntriesFromPayload(payload, mediaItems, logger)
  → resolveTimelineItemsForEntries(entries, dropFrame)
  → applyResolvedTimelineDrop()
```

### External File Drop (from OS file explorer)
```
OS file drag → DataTransfer.types includes 'Files'

TimelineTrack.handleDrop OR TimelineMediaDropZone.handleDrop:
  → extractValidMediaFileEntriesFromDataTransfer(dataTransfer)
    → supportsFileSystemDragDrop checks for getAsFileSystemHandle (Chrome-only!)
  → preflightFirstTimelineVideoProjectMatch(entries) — SHOWS DIALOG on first video
  → importHandlesForPlacement(handles) → imports file to OPFS
  → buildDroppedMediaEntriesFromImportedMedia(importedMedia)
  → resolveTimelineItemsForEntries(entries, dropFrame)
  → applyResolvedTimelineDrop()
```

## BUG: External File Drop on CompositingTimeline (Motion Workspace)

### Location
`features/editor/components/compose-workspace/compositing-timeline.tsx`

### Problem 1: handleDragOver (line 5396-5404)
```typescript
const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
  const hasLayerPayload =
    getMediaDragData() !== null ||
    Array.from(event.dataTransfer.types).includes('application/json')
  if (!hasLayerPayload) return  // ← RETURNS EARLY for external file drops!
  // ...
}, [])
```
**Issue**: `handleDragOver` only allows drags that have internal media drag data OR an `application/json` data type. External file drops (which only have `Files` type) cause an early return WITHOUT calling `event.preventDefault()`, so the browser shows the "not allowed" cursor and the drop is rejected.

### Problem 2: handleDrop (line 5270-5393)
```typescript
const handleDrop = useCallback(async (event) => {
  event.preventDefault()
  // ...
  const raw = event.dataTransfer.getData('application/json')
  let payload: unknown = getMediaDragData()
  // ...
  if (!payload || typeof payload !== 'object') return  // ← EXITS for external files
  // ... only handles composition, timeline-template, and media-items payloads
  // NEVER reaches resolveDroppedMediaEntriesFromExternalFiles
}, [...])
```
**Issue**: `handleDrop` never checks for `e.dataTransfer.types.includes('Files')` and never calls `resolveDroppedMediaEntriesFromExternalFiles`. External file drops on the CompositingTimeline are silently dropped.

The classic `TimelineTrack` and `TimelineMediaDropZone` both handle external file drops correctly — only the `CompositingTimeline` is broken.

### Severity: HIGH
Any user in the Motion workspace who tries to drag a file from Finder/Explorer onto the timeline will see no effect. The cursor shows "not allowed" and nothing happens.

---

## Potential Bug: console.log debug statements in production code

### Location: `features/media-library/stores/media-library-store.ts`
Lines 224 and 226:
```typescript
console.log('[MediaLibraryStore] loadMediaItems calling getMediaForProject for:', currentProjectId)
console.log('[MediaLibraryStore] loadMediaItems got mediaItems:', mediaItems.map(m => m.id))
```
**Issue**: Debug `console.log` statements left in production code. Should be `logger.debug()` instead.

---

## Potential Bug: project-media-match dialog blocking drag-drop

### Location: `features/timeline/utils/external-file-project-match.ts`
```typescript
await useProjectMediaMatchDialogStore.getState().requestProjectMediaMatch(currentProjectId, {
  fileName, width, height, fps
})
```
**Issue**: On first video import into a project, this shows a modal dialog asking the user to match project dimensions/FPS. The `requestProjectMediaMatch` returns a Promise that only resolves when the user picks a choice in the dialog. If the user dismisses without choosing, the promise never resolves, hanging the drop handler indefinitely.

However, `handledProjectIds` tracks resolved projects, so this only blocks once per project. After the first resolution, `requestProjectMediaMatch` returns `Promise.resolve('keep-current')` immediately.

**Severity: MEDIUM** — only affects first-ever video drop per project, and only if the user dismisses the dialog without choosing.

---

## Architecture Flow: Editor Mount → Timeline Render

1. `editor.tsx:LoadedEditor` mounts
2. `useEffect[470]` calls `loadTimeline(projectId)` → `hydrateTimelineStoresFromProject(project)`
3. `hydrateTimelineStoresFromProject` sets `activeCompositionId: null` (Main Timeline) — does NOT call `setActiveCompositionId`
4. `setMediaProject(projectId)` + `loadMediaItems()` called in parallel
5. Render: `workspace === 'motion'` ? `<MotionTimelineDock>` : `<LazyTimeline>`
6. Default `workspace` is `'edit'` → renders `<LazyTimeline>` (classic Timeline)
7. Classic Timeline renders `TimelineContent` → renders `TimelineTrack` + `TimelineMediaDropZone`
8. `MotionTimelineDock` only renders `CompositingTimeline` when `activeComposition?.editorKind === 'composite-2d'`

---

## Diagnostic Checklist (verified)

- [x] Internal drag from media-sidebar works on classic timeline (TimelineTrack + TimelineMediaDropZone both handle `media-items`/`media-item` payloads)
- [x] External file drop works on classic timeline (both TimelineTrack and TimelineMediaDropZone check `e.dataTransfer.types.includes('Files')`)
- [ ] External file drop does NOT work on CompositingTimeline (handleDragOver/handleDrop never check for 'Files')
- [x] Internal drag payload lookup: `resolveDroppedMediaEntriesFromPayload` uses `mediaItems` array → `mediaById` map lookup
- [x] External file import: `importHandlesForPlacement` → `processImportResults` → `ensureImportedMediaVisible` adds media to store
- [x] `resolveTimelineItemsForEntries` resolves blob URLs via `resolveMediaUrl(entry.mediaId)` — returns '' on failure, item silently dropped
- [ ] Debug console.log statements present in media-library-store.ts (lines 224, 226)
- [ ] Project-media-match dialog can block on first video drop (one-time per project)
- [ ] `supportsFileSystemDragDrop` uses Chrome-only `getAsFileSystemHandle` — may not work in all Tauri WebViews
