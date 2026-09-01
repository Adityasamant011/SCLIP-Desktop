import { invoke } from '@tauri-apps/api/core'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { detectTimelineModificationCorrection } from '@/perception'

const STORAGE_KEY = 'sclip:pending-ai-style-attributions:v1'

type PendingStyleAttribution = {
  projectId: string
  planId: string
  operationId: string
  itemId: string
  contentType: 'general'
  baselineWidth: number
  proposedWidth: number
  createdAt: number
}

let installed = false
let pending = new Map<string, PendingStyleAttribution>()

function attributionKey(value: Pick<PendingStyleAttribution, 'projectId' | 'planId' | 'operationId' | 'itemId'>) {
  return `${value.projectId}:${value.planId}:${value.operationId}:${value.itemId}`
}

function persistPending() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...pending.values()]))
  } catch {
    // Style capture is additive. A storage failure must never interrupt editing.
  }
}

function loadPending() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as PendingStyleAttribution[]
    pending = new Map(parsed
      .filter((entry) => entry && Date.now() - entry.createdAt < 30 * 24 * 60 * 60 * 1000)
      .map((entry) => [attributionKey(entry), entry]))
  } catch {
    pending = new Map()
  }
}

async function recordManualCorrection(attribution: PendingStyleAttribution, currentWidth: number) {
  const baselineWidth = Math.max(1, attribution.baselineWidth)
  const correction = detectTimelineModificationCorrection({
    projectId: attribution.projectId,
    planId: attribution.planId,
    operationId: attribution.operationId,
    contentType: attribution.contentType,
    aiProposedState: {
      itemId: attribution.itemId,
      punchInScale: attribution.proposedWidth / baselineWidth,
    },
    userModifiedState: {
      itemId: attribution.itemId,
      punchInScale: currentWidth / baselineWidth,
    },
  })
  if (!correction) return

  pending.delete(attributionKey(attribution))
  persistPending()
  await invoke('sclip_correction_event', {
    action: 'record',
    projectId: attribution.projectId,
    planId: attribution.planId,
    operationId: attribution.operationId,
    outcome: 'modified',
    correction: {
      ...correction,
      itemId: attribution.itemId,
      aiProposedState: { width: attribution.proposedWidth, punchInScale: attribution.proposedWidth / baselineWidth },
      userModifiedState: { width: currentWidth, punchInScale: currentWidth / baselineWidth },
      capture: 'automatic_gui_timeline_observer',
    },
  })
}

/** Install the production listener that observes later human edits to AI-touched items. */
export function installAutomaticCorrectionCapture() {
  if (installed || typeof window === 'undefined') return
  installed = true
  loadPending()
  useTimelineStore.subscribe(() => {
    const state = useTimelineStore.getState()
    const projectId = useProjectStore.getState().currentProject?.id
    if (!projectId || pending.size === 0) return
    for (const attribution of pending.values()) {
      if (attribution.projectId !== projectId) continue
      const item = state.items.find((candidate) => candidate.id === attribution.itemId)
      const width = Number((item as unknown as { transform?: { width?: number } } | undefined)?.transform?.width)
      if (!Number.isFinite(width)) continue
      if (Math.abs(width - attribution.proposedWidth) <= 0.5) continue
      void recordManualCorrection(attribution, width).catch(() => undefined)
    }
  })
}

/** Register an applied AI EditPlan transform after the mutation reaches the live store. */
export function registerAiTransformAttribution(input: Omit<PendingStyleAttribution, 'contentType' | 'createdAt'>) {
  if (!Number.isFinite(input.baselineWidth) || !Number.isFinite(input.proposedWidth) || input.baselineWidth <= 0) return
  const attribution: PendingStyleAttribution = { ...input, contentType: 'general', createdAt: Date.now() }
  pending.set(attributionKey(attribution), attribution)
  persistPending()
}

export function clearPendingAttributionsForProject(projectId: string) {
  pending = new Map([...pending].filter(([, attribution]) => attribution.projectId !== projectId))
  persistPending()
}
