/**
 * Small, persistent editor diagnostics ledger.
 *
 * This is deliberately independent of console logging: user-facing desktop
 * failures (native drag/drop, a rejected save, or an unhandled renderer error)
 * must still be inspectable after the screen has recovered or the app reloads.
 */
export type EditorDiagnosticLevel = 'info' | 'warn' | 'error'

export interface EditorDiagnosticEntry {
  at: string
  source: string
  level: EditorDiagnosticLevel
  message: string
  details?: Record<string, unknown>
}

const STORAGE_KEY = 'sclip:editor-diagnostics:v1'
const MAX_ENTRIES = 200
let entries: EditorDiagnosticEntry[] = []

/** Stable fixture IDs support can request for a reproducible project. */
const REPRODUCTION_FIXTURES = [
  { id: 'single-video', purpose: 'Selection, inspector, undo/redo, and save baseline' },
  { id: 'multi-track', purpose: 'Layering, track roles, and timeline layout' },
  { id: 'with-transitions', purpose: 'Transition placement and edit boundaries' },
  { id: 'with-keyframes', purpose: 'Animation and property-panel persistence' },
  { id: 'complex', purpose: 'Mixed timeline state, markers, transitions, and keyframes' },
  { id: 'stress-test', purpose: 'Large timeline performance and persistence' },
] as const

function load(): void {
  if (entries.length > 0 || typeof localStorage === 'undefined') return
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(value)) entries = value.slice(-MAX_ENTRIES)
  } catch {
    entries = []
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Diagnostics must never block editing when browser storage is unavailable.
  }
}

export function recordEditorDiagnostic(
  source: string,
  level: EditorDiagnosticLevel,
  message: string,
  details?: Record<string, unknown>,
): void {
  load()
  entries.push({ at: new Date().toISOString(), source, level, message, ...(details ? { details } : {}) })
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  persist()
}

export function getEditorDiagnostics(): EditorDiagnosticEntry[] {
  load()
  return [...entries]
}

export function clearEditorDiagnostics(): void {
  entries = []
  persist()
}

/**
 * A small, copyable support artifact. It deliberately contains project
 * structure and operational errors, never media bytes, prompt text, tokens,
 * local file paths, or credentials. This makes an editor's bug report useful
 * without turning diagnostics into a second source of private user data.
 */
export async function buildEditorDiagnosticReport(): Promise<string> {
  const [{ useTimelineStore }, { useSelectionStore }, { useProjectStore }] = await Promise.all([
    import('@/features/editor/deps/timeline-store'),
    import('@/shared/state/selection/store'),
    import('@/features/editor/deps/projects'),
  ])
  const timeline = useTimelineStore.getState()
  const selection = useSelectionStore.getState()
  const project = useProjectStore.getState().currentProject
  let agentAudit: unknown[] = []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const audit = await invoke<{ entries?: unknown[] }>('sclip_agent_audit', { action: 'list' })
    agentAudit = Array.isArray(audit.entries) ? audit.entries.slice(0, 80) : []
  } catch {
    // Browser/test environments do not expose Tauri; the rest of the report
    // still gives support enough editor state to reproduce the issue.
  }
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    app: 'SCLIP / FreeCut',
    environment: {
      userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
      online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
    },
    project: project ? { id: project.id, name: project.name } : null,
    timeline: {
      dirty: timeline.isDirty,
      fps: timeline.fps,
      trackCount: timeline.tracks.length,
      itemCount: timeline.items.length,
      transitionCount: timeline.transitions.length,
      keyframeCount: timeline.keyframes.length,
      tracks: timeline.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind ?? 'video',
        order: track.order,
        locked: track.locked,
        visible: track.visible,
        muted: track.muted,
      })),
      selectedItemIds: selection.selectedItemIds,
      selectedTransitionId: selection.selectedTransitionId,
      selectedMarkerId: selection.selectedMarkerId,
      selectedTrackIds: selection.selectedTrackIds,
      undoDepth: useTimelineStore.temporal.getState().pastStates.length,
      redoDepth: useTimelineStore.temporal.getState().futureStates.length,
    },
    recentEvents: getEditorDiagnostics().slice(-80),
    recentAgentOperations: agentAudit,
    reproductionFixtures: REPRODUCTION_FIXTURES,
  }
  return JSON.stringify(report, null, 2)
}

export async function copyEditorDiagnosticReport(): Promise<void> {
  const report = await buildEditorDiagnosticReport()
  await navigator.clipboard.writeText(report)
  recordEditorDiagnostic('diagnostics', 'info', 'Support diagnostic report copied')
}
