/**
 * SCLIP MCP Bridge - Webview side
 *
 * Listens for tool calls from Rust (via Tauri events) and executes them
 * using SCLIP's editor stores, then returns results via handle_tool_result.
 *
 * This replaces the old sclip-mcp-bridge.ts with a minimal implementation
 * that directly uses the editor's existing actions.
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { resolveMediaUrl, useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { usePlaybackStore } from '@/shared/state/playback'
import { usePreviewBridgeStore } from '@/shared/state/preview-bridge'
import {
  createTextTemplateItem,
  createDefaultGradientItem,
  createDefaultShapeItem,
  createDefaultSolidColorItem,
  createOverlayLayerTrack,
  findCompatibleTrackForItemType,
  findNearestAvailableSpace,
  getDefaultGeneratedLayerDurationInFrames,
} from '@/features/editor/deps/timeline-utils'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import type { ShapeType, TextItem } from '@/types/timeline'
import type { VisualEffect } from '@/types/effects'
import { GPU_EFFECT_REGISTRY, getGpuEffect, getGpuEffectDefaultParams } from '@/infrastructure/gpu-effects'
import { GPU_TRANSITION_REGISTRY } from '@/infrastructure/gpu-transitions'
import { proxyService } from '@/features/media-library/services/proxy-service'
import { getSharedProxyKey } from '@/features/media-library/utils/proxy-key'
import { getMediaType } from '@/features/media-library/utils/validation'
import { buildDroppedMediaTimelineItem } from '@/features/timeline/utils/dropped-media'
import { createClassicTrack } from '@/features/timeline/utils/classic-tracks'
import { canAddTransition } from '@/features/timeline/utils/transition-utils'
import { validateItemUpdates, validateTransformUpdates } from '@/infrastructure/mcp-tool-contracts'
import { buildScriptTimelineRevision } from '@/shared/utils/script-timeline-revision'
import { buildTranscriptWordId } from '@/shared/utils/transcript-word-id'
import { buildTimelineRevision as buildComposedTimelineRevision } from '@/perception'
import { assertRevisionMatches } from './mcp-revision-guard'
import { clearPendingAttributionsForProject, registerAiTransformAttribution } from './automatic-correction-capture'

type ToolHandler = (args: any) => Promise<any>

function approvedToolHandler(name: string): ToolHandler {
  const handler = TOOL_HANDLERS[name]
  if (!handler) throw new Error(`Required deterministic executor is unavailable: ${name}`)
  return handler
}

const SCRIPT_FILLER_PATTERN = /^(?:um+|uh+|erm+|ah+)$/i

function normaliseScriptText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

async function loadProjectScript(projectId: string, mediaId?: string) {
  const project = await prepareProjectForAgent(projectId)
  const mediaStore = useMediaLibraryStore.getState()
  if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
  await mediaStore.loadMediaItems()
  const timeline = useTimelineStore.getState()
  const relevantItems = timeline.items.filter((item) =>
    (item.type === 'video' || item.type === 'audio') && !!item.mediaId && (!mediaId || item.mediaId === mediaId),
  )
  const mediaIds = Array.from(new Set(relevantItems.flatMap((item) => item.mediaId ? [item.mediaId] : [])))
  const { getTranscript } = await import('@/infrastructure/storage')
  const transcriptEntries = await Promise.all(mediaIds.map(async (id) => [id, await getTranscript(id)] as const))
  const { getTranscriptReliability } = await import('@/features/media-library/transcription/transcript-reliability')
  const transcriptReliability = Object.fromEntries(transcriptEntries.flatMap(([id, transcript]) => {
    if (!transcript) return []
    return [[id, getTranscriptReliability(transcript, mediaStore.mediaById[id]?.duration)] as const]
  }))
  // Raw ASR stays local for diagnostics, but only a reliable transcript can
  // become stable timeline words or a script-edit candidate.
  const transcriptsByMediaId = Object.fromEntries(transcriptEntries.map(([id, transcript]) => [
    id,
    transcript && transcriptReliability[id]?.transcriptReliable
      ? transcript
      : transcript ? { ...transcript, segments: [] } : transcript,
  ]))
  const { buildTranscriptTokens } = await import('@/features/editor/deps/timeline-contract')
  const tokens = buildTranscriptTokens(relevantItems, transcriptsByMediaId, timeline.fps)
  const scriptRevision = await buildScriptTimelineRevision({ fps: timeline.fps, items: timeline.items })
  return { project, timeline, tokens, scriptRevision, transcriptReliability }
}

function scriptWord(token: {
  wordId: string
  itemId: string
  mediaId: string
  text: string
  confidence?: number
  speaker?: string
  sourceStart: number
  sourceEnd: number
  startFrame: number
  endFrame: number
}, fps: number) {
  return {
    wordId: token.wordId,
    itemId: token.itemId,
    mediaId: token.mediaId,
    text: token.text,
    ...(typeof token.confidence === 'number' ? { confidence: Number(token.confidence.toFixed(3)) } : {}),
    ...(token.speaker ? { speaker: token.speaker } : {}),
    sourceStartSec: Number(token.sourceStart.toFixed(3)),
    sourceEndSec: Number(token.sourceEnd.toFixed(3)),
    timelineStartFrame: token.startFrame,
    timelineEndFrame: token.endFrame,
    timelineStartSec: Number((token.startFrame / Math.max(1, fps)).toFixed(3)),
    timelineEndSec: Number((token.endFrame / Math.max(1, fps)).toFixed(3)),
  }
}

type ScriptRemovalPreview = {
  operationIndex: number
  type: 'remove_words'
  itemId: string
  wordCount: number
  rangesByMediaId: Record<string, Array<{ start: number; end: number }>>
  words: ReturnType<typeof scriptWord>[]
}

/** Resolve only stable word references that still exist on the live timeline. */
async function previewScriptRemovalOperations(
  operations: unknown[],
  tokens: Awaited<ReturnType<typeof loadProjectScript>>['tokens'],
  fps: number,
): Promise<ScriptRemovalPreview[]> {
  const byPlacement = new Map(tokens.map((token) => [`${token.itemId}:${token.wordId}`, token]))
  const { buildRemovalRangesByMediaId } = await import('@/features/editor/deps/timeline-contract')

  return operations.map((operation, operationIndex) => {
    if (!operation || typeof operation !== 'object' || (operation as { type?: unknown }).type !== 'remove_words') {
      throw new Error(`Operation ${operationIndex} must be remove_words`)
    }
    const wordRefs = (operation as { word_refs?: unknown }).word_refs
    if (!Array.isArray(wordRefs) || wordRefs.length === 0) {
      throw new Error(`Operation ${operationIndex} must include non-empty word_refs`)
    }
    const selected = wordRefs.map((reference) => {
      const value = reference as { item_id?: unknown; word_id?: unknown }
      const itemId = String(value?.item_id || '')
      const wordId = String(value?.word_id || '')
      const token = byPlacement.get(`${itemId}:${wordId}`)
      if (!token) throw new Error(`Word reference ${wordId} on item ${itemId} is not present in the current script`)
      return token
    })
    const unique = Array.from(new Map(selected.map((token) => [`${token.itemId}:${token.wordId}`, token])).values())
    if (unique.length !== selected.length) throw new Error(`Operation ${operationIndex} repeats a word reference`)
    const itemIds = Array.from(new Set(unique.map((token) => token.itemId)))
    if (itemIds.length !== 1) {
      throw new Error(`Operation ${operationIndex} may target one timeline item only; split separate placements into separate operations`)
    }
    const ordered = unique.toSorted((left, right) => left.sourceStart - right.sourceStart)
    return {
      operationIndex,
      type: 'remove_words' as const,
      itemId: itemIds[0]!,
      wordCount: ordered.length,
      rangesByMediaId: buildRemovalRangesByMediaId(ordered),
      words: ordered.map((token) => scriptWord(token, fps)),
    }
  })
}

function staleScriptRevisionError(expectedRevision: string, scriptRevision: string): Error {
  const error = new Error(`REVISION_MISMATCH: expected script revision '${expectedRevision}', but current script revision is '${scriptRevision}'. Re-read and preview the script again.`)
  ;(error as Error & { code?: string; expected?: string; actual?: string; operation?: string }).code = 'REVISION_MISMATCH'
  ;(error as Error & { expected?: string }).expected = expectedRevision
  ;(error as Error & { actual?: string }).actual = scriptRevision
  ;(error as Error & { operation?: string }).operation = 'script_placement'
  return error
}

function normaliseRoughCutProposal(value: unknown, scriptRevision: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proposal must be a structured object')
  const source = value as Record<string, unknown>
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  const proposalRevision = String(source.scriptRevision ?? source.script_revision ?? '')
  const operations = Array.isArray(source.operations) ? source.operations : []
  if (!summary) throw new Error('proposal.summary is required')
  if (!proposalRevision) throw new Error('proposal.scriptRevision from video_read_script is required')
  if (proposalRevision !== scriptRevision) throw staleScriptRevisionError(proposalRevision, scriptRevision)
  if (operations.length === 0) throw new Error('proposal.operations must contain at least one reviewable remove_words operation')
  return {
    schemaVersion: 1,
    summary,
    ...(typeof source.goal === 'string' && source.goal.trim() ? { goal: source.goal.trim() } : {}),
    scriptRevision,
    operations,
    ...(Array.isArray(source.hookOptions) ? { hookOptions: source.hookOptions } : {}),
    ...(Array.isArray(source.limitations) ? { limitations: source.limitations } : {
      limitations: ['This first rough-cut workflow only removes confirmed transcript ranges; it does not reorder, invent, or silently rewrite footage.'],
    }),
  }
}

/**
 * MCP requests can arrive before the editor route finishes mounting.
 * Re-establish the same Tauri workspace handle the editor uses so agent calls
 * never depend on a user first clicking a media item or visiting a panel.
 */
async function ensureSclipWorkspaceForAgent() {
  const { ensureTauriWorkspace } = await import('@/infrastructure/storage/workspace-fs/root')
  if (!(await ensureTauriWorkspace())) {
    throw new Error('SCLIP workspace is not ready. Open the project in SCLIP and try again.')
  }
}

/**
 * Make an agent action join the project already open in the editor.
 *
 * The visible timeline is shared by the human and SCLIP. Re-loading it for
 * every tool call is destructive: it can replace edits the human has made
 * since the last save. We only hydrate when the agent explicitly targets a
 * different project; otherwise we first flush the live timeline and continue
 * from those exact stores.
 */
async function prepareProjectForAgent(projectId: string) {
  await ensureSclipWorkspaceForAgent()
  const projectStore = useProjectStore.getState()
  const timelineStore = useTimelineStore.getState()
  const currentProject = projectStore.currentProject

  if (typeof window !== 'undefined' && window.location) {
    const targetHash = `#/editor/${projectId}`
    if (!window.location.hash.startsWith(targetHash)) {
      window.location.hash = targetHash
    }
  }

  if (currentProject?.id === projectId) {
    if (timelineStore.isDirty) {
      await timelineStore.saveTimeline(projectId)
    }
    return currentProject
  }

  await projectStore.loadProject(projectId)
  const loadedProject = useProjectStore.getState().currentProject
  if (!loadedProject || loadedProject.id !== projectId) {
    throw new Error(`Project not found: ${projectId}`)
  }
  await useTimelineStore.getState().loadTimeline(projectId)
  return loadedProject
}

async function prepareTimelineMutation(
  projectId: string,
  itemId: string,
  expectedRevision: string | undefined,
  operation?: string,
): Promise<{ timeline: ReturnType<typeof useTimelineStore.getState>; item: NonNullable<ReturnType<typeof useTimelineStore.getState>['items'][number]>; currentRevision: string }>
async function prepareTimelineMutation(
  projectId: string,
  itemId: undefined,
  expectedRevision: string | undefined,
  operation?: string,
): Promise<ReturnType<typeof useTimelineStore.getState>>
async function prepareTimelineMutation(
  projectId: string,
  itemId?: string,
  expectedRevision?: string,
  operation = 'timeline_mutation',
) {
  const project = await prepareProjectForAgent(projectId)
  const currentRevision = getLiveProjectRevision(project)
  assertRevisionMatches(expectedRevision, currentRevision, operation)
  const timeline = useTimelineStore.getState()
  if (!itemId) return timeline
  const item = timeline.items.find((candidate) => candidate.id === itemId)
  if (!item) throw new Error(`Timeline item not found: ${itemId}`)
  assertTrackIsMutable(timeline, item.trackId, operation)
  return { timeline, item, currentRevision }
}

function assertTrackIsMutable(
  timeline: Pick<ReturnType<typeof useTimelineStore.getState>, 'tracks'>,
  trackId: string,
  operation: string,
) {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`Track not found: ${trackId}`)
  if (track.locked) {
    throw new Error(JSON.stringify({ code: 'TRACK_LOCKED', trackId, operation }))
  }
}

/**
 * Evidence and mutation guards must follow the state currently visible in
 * FreeCut, including unsaved work—not merely a project's last save time.
 */
export function getLiveProjectRevision(project: Awaited<ReturnType<typeof prepareProjectForAgent>>): string {
  const timeline = useTimelineStore.getState()
  // This contract intentionally includes every compositing input. The helper
  // is synchronous and local; it does not ask Hermes to judge editor state.
  return buildComposedTimelineRevision({
    projectId: project.id,
    fps: timeline.fps,
    items: timeline.items,
    tracks: timeline.tracks,
    transitions: timeline.transitions,
    keyframes: timeline.keyframes,
    markers: timeline.markers,
    inPoint: timeline.inPoint,
    outPoint: timeline.outPoint,
  })
}

async function saveTimelineMutation(projectId: string) {
  await useTimelineStore.getState().saveTimeline(projectId)
}

type EditorialEvidenceRef = {
  id: string
  scope: 'source' | 'timeline' | 'composed'
  kind: string
  summary: string
  anchor: Record<string, unknown>
  limitations: string[]
}

/**
 * Join existing, bounded observations for Hermes. This is a view over the
 * established transcript/media/semantic-map stores, never a second perception
 * pipeline or a project JSON dump.
 */
async function buildEditorialEvidenceBundle(projectId: string, objective: string) {
  const { project, timeline, tokens, scriptRevision } = await loadProjectScript(projectId)
  const projectRevision = getLiveProjectRevision(project)
  const mediaStore = useMediaLibraryStore.getState()
  const relevantItems = timeline.items.filter((item) => (item.type === 'video' || item.type === 'audio') && item.mediaId)
  const mediaIds = Array.from(new Set(relevantItems.flatMap((item) => item.mediaId ? [item.mediaId] : []))).slice(0, 12)
  const [{ getSemanticMediaMap }, { buildAssetFingerprint }] = await Promise.all([
    import('@/infrastructure/storage'), import('@/perception'),
  ])
  const refs: EditorialEvidenceRef[] = []
  const limitations: string[] = []
  const timelineRef: EditorialEvidenceRef = {
    id: `timeline:${projectRevision}:summary`, scope: 'timeline', kind: 'timeline_summary',
    summary: `${timeline.items.length} timeline items across ${timeline.tracks.length} tracks.`,
    anchor: { projectId, projectRevision }, limitations: ['Summary intentionally excludes keyframes, effects, and full project JSON.'],
  }
  refs.push(timelineRef)

  const wantsOpening = /\b(open|hook|first|start)\b/i.test(objective)
  const selectedTokens = (wantsOpening ? tokens : tokens.slice(0, 180)).slice(0, 180)
  const transcriptEvidence = selectedTokens.slice(0, 120).map((token) => scriptWord(token, timeline.fps))
  if (selectedTokens.length) {
    const first = selectedTokens[0]!
    const last = selectedTokens.at(-1)!
    refs.push({
      id: `script:${first.itemId}:${first.wordId}:${last.wordId}`, scope: 'timeline', kind: 'script_window',
      summary: `Bounded ${selectedTokens.length}-word script window${wantsOpening ? ' for the opening' : ''}.`,
      anchor: { projectId, projectRevision, timelineRange: { startFrame: first.startFrame, endFrame: last.endFrame } },
      limitations: tokens.length > selectedTokens.length ? ['Only a bounded script window is included. Read later pages if needed.'] : [],
    })
  } else limitations.push('No placement-aware transcript is available on the timeline.')

  const visualEvidence: EditorialEvidenceRef[] = []
  const sceneEvidence: EditorialEvidenceRef[] = []
  const heuristicCandidates: Array<Record<string, unknown>> = []
  for (const mediaId of mediaIds) {
    const media = mediaStore.mediaById[mediaId]
    if (!media) continue
    const fingerprint = buildAssetFingerprint({ mediaId, contentHash: media.contentHash, fileSize: media.fileSize, fileLastModified: media.fileLastModified, mimeType: media.mimeType })
    const captions = (media.aiCaptions ?? []).slice(0, 6)
    if (captions.length) {
      visualEvidence.push({ id: `source:${fingerprint}:sclip-media-analysis-v1`, scope: 'source', kind: 'visual_observations', summary: `${captions.length} timestamped source observations for ${media.fileName}.`, anchor: { assetId: mediaId, assetFingerprint: fingerprint }, limitations: ['Samples describe selected source frames, not every frame.'] })
      sceneEvidence.push(...captions.slice(0, 4).map((caption, index) => ({ id: `scene:${mediaId}:${index}`, scope: 'source' as const, kind: 'scene_observation', summary: caption.text, anchor: { assetId: mediaId, assetFingerprint: fingerprint, sourceRange: { startSec: caption.timeSec, endSec: caption.timeSec } }, limitations: ['Source observation only.'] })))
    }
    const map = await getSemanticMediaMap(mediaId)
    if (map && map.sourceAnchor.assetFingerprint === fingerprint) {
      refs.push({ id: `semantic:${mediaId}:${map.analyzerVersion}`, scope: 'source', kind: 'heuristic_map', summary: `${map.reviewCandidates.length} review candidates from existing semantic map.`, anchor: { ...map.sourceAnchor }, limitations: map.grounding.limitations })
      heuristicCandidates.push(...map.reviewCandidates.slice(0, 30).map((candidate) => ({ evidenceId: `candidate:${mediaId}:${candidate.id}`, mediaId, ...candidate })))
    }
  }
  refs.push(...visualEvidence, ...sceneEvidence)
  if (!visualEvidence.length) limitations.push('No existing source VLM observations are available; visual evidence is degraded.')
  limitations.push('Audio analysis is not included because no bounded, timeline-linked audio evidence was available in this request.')
  const creatorContext = await invoke<{ preferences?: unknown; projectContext?: unknown }>('sclip_editing_memory', { action: 'get', projectId }).catch(() => ({}))
  const correctionArchive = await invoke<{ events?: Array<{ correction?: unknown }> }>('sclip_correction_event', { action: 'list', projectId }).catch(() => ({ events: [] }))
  const { reconstructStyleProfileFromEvents, getCreatorStyleContext } = await import('@/perception')
  const correctionEvents = (correctionArchive.events ?? []).flatMap((entry) => entry.correction && typeof entry.correction === 'object' ? [entry.correction] : [])
  const styleProfile = reconstructStyleProfileFromEvents(correctionEvents as never[], 'local_creator')
  const behavioralStyle = getCreatorStyleContext(styleProfile, { projectId, contentType: 'general' })
  refs.push({ id: `creator:${projectId}:context`, scope: 'timeline', kind: 'creator_context', summary: 'Explicit creator preferences and project context.', anchor: { projectId, projectRevision }, limitations: ['Only saved structured context is included; no chat history is copied.'] })
  return {
    schemaVersion: 1, projectId, projectRevision, objective: objective.slice(0, 500),
    timelineSummary: { fps: timeline.fps, itemCount: timeline.items.length, trackCount: timeline.tracks.length, durationFrames: timeline.items.reduce((end, item) => Math.max(end, item.from + item.durationInFrames), 0), scriptRevision },
    transcriptEvidence: { words: transcriptEvidence, totalWords: tokens.length, returnedWords: transcriptEvidence.length },
    audioEvidence: { status: 'degraded', observations: [], limitation: 'No bounded audio evidence is currently linked to the visible timeline.' },
    visualEvidence, sceneEvidence, heuristicCandidates,
    creatorContext: { ...creatorContext, behavioralStyle }, evidenceRefs: refs, limitations: Array.from(new Set(limitations)),
  }
}

function planPreviewFromOperations(plan: import('@/features/editor/agent/edit-plan').SclipEditPlan, previews: Array<{ operationId: string; preview: unknown }>) {
  const estimatedDurationChangeSec = previews.reduce((total, entry) => {
    const scriptPreview = entry.preview as { preview?: Array<{ rangesByMediaId?: Record<string, Array<{ start: number; end: number }>> }> }
    return total + (scriptPreview.preview ?? []).flatMap((item) => Object.values(item.rangesByMediaId ?? {}))
      .flat().reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0)
  }, 0)
  return {
    planId: undefined, title: plan.title, goal: plan.goal, projectRevision: plan.projectRevision,
    operations: plan.operations.map((operation) => ({ id: operation.id, executor: operation.executor, summary: operation.summary, risk: operation.risk, affectedRange: operation.affectedRange, evidenceIds: operation.evidenceIds, expectedOutcome: operation.expectedOutcome })),
    executorPreviews: previews, estimatedDurationChangeSec: Number(estimatedDurationChangeSec.toFixed(3)), limitations: plan.limitations,
  }
}

/**
 * Project.timeline is the last persisted snapshot. The Zustand timeline store
 * is the real, on-screen editor state, so this compact view is what SCLIP
 * must reason over before making an edit.
 */
function buildLiveTimelineInspection(project: Awaited<ReturnType<typeof prepareProjectForAgent>>) {
  const timeline = useTimelineStore.getState()
  const durationInFrames = timeline.items.reduce(
    (latest, item) => Math.max(latest, item.from + item.durationInFrames),
    0,
  )
  const revision = getLiveProjectRevision(project)
  const items = timeline.items
    .slice()
    .sort((left, right) => left.from - right.from || left.trackId.localeCompare(right.trackId))
    .map((item) => {
      const raw = item as unknown as Record<string, unknown>
      return {
        id: item.id,
        type: item.type,
        label: item.label,
        trackId: item.trackId,
        fromFrame: item.from,
        durationFrames: item.durationInFrames,
        endFrame: item.from + item.durationInFrames,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        ...(item.linkedGroupId ? { linkedGroupId: item.linkedGroupId } : {}),
        ...(typeof raw.embeddedAudioMuted === 'boolean'
          ? { embeddedAudioMuted: raw.embeddedAudioMuted }
          : {}),
        ...(typeof raw.volume === 'number' ? { volume: raw.volume } : {}),
        ...(typeof raw.muted === 'boolean' ? { muted: raw.muted } : {}),
        ...(typeof raw.speed === 'number' ? { speed: raw.speed } : {}),
        ...(item.type === 'text' ? { text: item.text } : {}),
        ...(typeof raw.sourceStart === 'number' ? { sourceStartFrame: raw.sourceStart } : {}),
        ...(typeof raw.sourceDuration === 'number' ? { sourceDurationFrames: raw.sourceDuration } : {}),
        ...(raw.transform ? { transform: raw.transform } : {}),
        ...(item.effects?.length
          ? { effects: item.effects.map((effect) => ({ id: effect.id, type: effect.effect.gpuEffectType })) }
          : {}),
      }
    })

  return {
    projectId: project.id,
    projectName: project.name,
    projectRevision: revision,
    canvas: { width: project.metadata.width, height: project.metadata.height },
    fps: timeline.fps,
    durationInFrames,
    durationSeconds: Number((durationInFrames / Math.max(1, timeline.fps)).toFixed(3)),
    activeTimelineIsSaved: !timeline.isDirty,
    inOut: { inFrame: timeline.inPoint, outFrame: timeline.outPoint },
    tracks: timeline.tracks
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind ?? 'video',
        order: track.order,
        locked: track.locked,
        visible: track.visible,
        muted: track.muted,
        solo: track.solo,
        isGroup: track.isGroup ?? false,
        parentTrackId: track.parentTrackId ?? null,
        itemIds: items.filter((item) => item.trackId === track.id).map((item) => item.id),
      })),
    items,
    transitions: timeline.transitions.map((transition) => ({
      id: transition.id,
      type: transition.type,
      fromItemId: transition.leftClipId,
      toItemId: transition.rightClipId,
      durationFrames: transition.durationInFrames,
    })),
    keyframeItemIds: timeline.keyframes.map((keyframes) => keyframes.itemId),
    markers: timeline.markers.map((marker) => ({ frame: marker.frame, label: marker.label ?? '' })),
  }
}

function primitiveParams(params: Record<string, unknown>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else {
      throw new Error(`Effect parameter ${key} must be a string, number, or boolean`)
    }
  }
  return result
}

function normalizeEffectType(effectType: unknown): string {
  const value = String(effectType ?? '').trim()
  if (!value) throw new Error('effect_type is required')
  return value.startsWith('gpu-') ? value : `gpu-${value}`
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Runtime health is intentionally conservative. A feature is available only
  // when its live process or browser dependency has been observed; configured
  // code paths and optional model downloads are reported as degraded instead.
  video_runtime_health: async () => {
    const gateway = await invoke<{
      guiPid: number
      projectId: string
      profile: string
      port: number
      startedAtMs: number
      hermesPid: number
      watchdogPids: number[]
      mcpPids: number[]
      health: 'AVAILABLE' | 'DEGRADED'
      mcpHealth: 'AVAILABLE' | 'DEGRADED'
    } | null>('get_sclip_agent_gateway_diagnostic').catch(() => null)
    const { probeCapabilities, probeLocalVisualModelCaches } = await import('@/perception')
    const hasAuthoritativeRenderer = !!usePreviewBridgeStore.getState().captureCanvasSource
    const [capabilities, visualModelCaches] = await Promise.all([
      probeCapabilities({ hasAuthoritativeRenderer }),
      probeLocalVisualModelCaches(),
    ])
    const gatewayStatus = gateway?.health === 'AVAILABLE' ? 'AVAILABLE' : gateway ? 'DEGRADED' : 'UNAVAILABLE'
    const mcpStatus = gateway?.mcpHealth === 'AVAILABLE' ? 'AVAILABLE' : gateway ? 'DEGRADED' : 'UNAVAILABLE'
    return {
      timestamp: new Date().toISOString(),
      gateway: {
        status: gatewayStatus,
        reason: gateway ? (gatewayStatus === 'AVAILABLE' ? undefined : 'HERMES_PORT_NOT_LISTENING') : 'HERMES_GATEWAY_NOT_RUNNING',
        diagnostic: gateway,
      },
      mcp: {
        status: mcpStatus,
        reason: mcpStatus === 'AVAILABLE' ? undefined : gateway ? 'MCP_PROCESS_NOT_OBSERVED' : 'MCP_DISCONNECTED',
      },
      editorialIntelligence: {
        contract: 'sclip-editorial-intelligence-v1',
        bridge: 'sclip-mcp-bridge-editorial-v1',
        tools: ['video_get_editorial_evidence', 'video_get_editing_guidance', 'video_edit_plan'],
      },
      // Provider reachability/auth is not probed here because doing so could
      // send project data or spend credits. Hermes must treat this as unknown
      // until an explicitly opt-in real-model acceptance run proves it.
      modelProvider: {
        status: 'DEGRADED',
        reason: 'MODEL_PROVIDER_NOT_PROBED',
      },
      sourceFrameExtraction: capabilities.sourceFrameExtraction,
      localVision: capabilities.visionUnderstanding,
      semanticVisualSearch: {
        status: visualModelCaches.clip.downloaded && capabilities.visionUnderstanding.status === 'available' ? 'available' : 'degraded',
        backend: 'local_clip_transformers_js',
        reason: visualModelCaches.clip.downloaded ? undefined : 'LOCAL_CLIP_WEIGHTS_UNINITIALIZED',
        cache: visualModelCaches.clip,
      },
      localVisualModelCaches: visualModelCaches,
      transcription: capabilities.transcription,
      sceneAnalysis: capabilities.sceneDetection,
      render: capabilities.render,
      composedPreview: capabilities.timelineFrameRendering,
      notes: [
        'AVAILABLE means a concrete runtime dependency was observed during this probe.',
        'DEGRADED and UNAVAILABLE capabilities must not be described as successful analysis or rendering.',
      ],
    }
  },

  // Dynamic capability matrix and authoritative epistemic guidance.
  video_editor_capabilities: async () => {
    const { probeCapabilities } = await import('@/perception')
    const dynamicCapabilities = await probeCapabilities({
      hasAuthoritativeRenderer: !!usePreviewBridgeStore.getState().captureCanvasSource,
    })

    return {
      version: '2.0.0',
      capabilities: dynamicCapabilities,
      epistemicRules: {
        visualVerification: 'Only claim visual verification if composed-frame observation succeeds on the current revision hash.',
        assetSemantics: 'Media assets in the library are distinct from placed timeline items. Inspect isOnTimeline and placements.',
        observationFallbacks: 'If semantic vision is degraded or unavailable, report the limitation explicitly rather than improvising content-dependent edits.',
        semanticEditing: 'Use video_build_semantic_map after transcription and source analysis. Its candidates require editorial review; never treat them as automatic delete instructions.',
      },
      effects: Array.from(GPU_EFFECT_REGISTRY.values()).map((effect) => ({
        id: effect.id,
        name: effect.name,
        category: effect.category,
        params: Object.fromEntries(Object.entries(effect.params).map(([id, param]) => [id, {
          type: param.type,
          label: param.label,
          default: param.default,
          min: param.min,
          max: param.max,
          step: param.step,
          options: param.options,
          animatable: param.animatable ?? false,
        }])),
      })),
      transitions: Array.from(GPU_TRANSITION_REGISTRY.values()).map((transition) => ({
        id: transition.id,
        name: transition.name,
        category: transition.category,
        hasDirection: transition.hasDirection,
        directions: transition.directions ?? [],
      })),
      editableItemProperties: {
        text: ['label', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'textAlign', 'letterSpacing', 'lineHeight', 'strokeColor', 'strokeWidth', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY'],
        audio: ['volume', 'muted', 'audioFadeIn', 'audioFadeOut', 'audioFadeInCurve', 'audioFadeOutCurve', 'audioPitchSemitones', 'audioPitchCents', 'audioDucking'],
        clip: ['fadeIn', 'fadeOut', 'speed', 'isReversed', 'visible', 'locked', 'blendMode'],
        transform: ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'scaleX', 'scaleY', 'anchorX', 'anchorY'],
      },
    }
  },

  // Track ownership is essential to readable edits.  The agent should use
  // explicit, named tracks (primary footage, B-roll, graphics, captions,
  // music, VO) instead of letting overlays accidentally compete on one lane.
  video_manage_tracks: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || '').trim()
    if (!projectId) throw new Error('project_id is required')
    if (!['add', 'update', 'remove'].includes(action)) {
      throw new Error('action must be add, update, or remove')
    }
    const timeline = await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_manage_tracks')
    if (action === 'add') {
      const kind = args.kind === 'audio' ? 'audio' : 'video'
      const orders = timeline.tracks.map((track) => track.order)
      const order = kind === 'video'
        ? Math.min(0, ...orders) - 1
        : Math.max(0, ...orders) + 1
      const track = createClassicTrack({ tracks: timeline.tracks, kind, order })
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : track.name
      timeline.setTracks([...timeline.tracks, { ...track, name }])
      await saveTimelineMutation(projectId)
      return { success: true, action, track: { id: track.id, name, kind, order } }
    }

    const trackId = String(args.track_id || '')
    const track = timeline.tracks.find((candidate) => candidate.id === trackId)
    if (!track) throw new Error(`Track not found: ${trackId}`)
    if (action === 'remove') {
      if (timeline.items.some((item) => item.trackId === trackId)) {
        throw new Error(`Track ${track.name} still contains items. Move or remove them before deleting the track.`)
      }
      timeline.setTracks(timeline.tracks.filter((candidate) => candidate.id !== trackId))
      await saveTimelineMutation(projectId)
      return { success: true, action, trackId }
    }

    const updates = args.updates && typeof args.updates === 'object' ? args.updates : {}
    const allowed = ['name', 'locked', 'visible', 'muted', 'solo', 'volume', 'order']
    const next: Record<string, unknown> = {}
    for (const field of allowed) {
      if (field in updates) next[field] = updates[field]
    }
    if (typeof next.name === 'string') next.name = next.name.trim() || track.name
    timeline.setTracks(timeline.tracks.map((candidate) => candidate.id === trackId ? { ...candidate, ...next } : candidate))
    await saveTimelineMutation(projectId)
    return { success: true, action, track: { ...track, ...next } }
  },

  // Reviews what the user can actually see using SCLIP's authoritative compositor.
  // The preview surface represents the final composite (media, text, transforms,
  // effects, transitions and track visibility).
  video_review_preview: async (args) => {
    const projectId = String(args.project_id || '')
    if (!projectId) throw new Error('project_id is required')
    const project = await prepareProjectForAgent(projectId)
    const timeline = useTimelineStore.getState()
    const projectRevision = getLiveProjectRevision(project)
    const { describeComposedFrame } = await import('@/perception')
    const { captionImage } = await import('@/features/media-library/deps/analysis-contract')
    const lastFrame = Math.max(0, timeline.items.reduce((end, item) => Math.max(end, item.from + item.durationInFrames), 0) - 1)
    const clampFrame = (value: unknown) => Math.max(0, Math.min(Math.round(Number(value) || 0), lastFrame))
    const requestedFrames: number[] = Array.isArray(args.frames)
      ? Array.from(new Set(args.frames.filter((frame: unknown): frame is number => typeof frame === 'number' && Number.isFinite(frame)).map(clampFrame))).slice(0, 8)
      : []
    if (!requestedFrames.length) requestedFrames.push(Number.isFinite(args.frame) ? clampFrame(args.frame) : clampFrame(usePlaybackStore.getState().currentFrame))

    const reviews = [] as Array<Record<string, unknown>>
    for (const requestedFrame of requestedFrames) {
      usePlaybackStore.getState().setCurrentFrame(requestedFrame)
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (!done) {
            done = true
            resolve()
          }
        }
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(() => requestAnimationFrame(finish))
        }
        setTimeout(finish, 50)
      })
      let capture = usePreviewBridgeStore.getState().captureCanvasSource
      if (!capture) {
        for (let i = 0; i < 50; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          capture = usePreviewBridgeStore.getState().captureCanvasSource
          if (capture) break
        }
      }
      let canvas = null
      if (capture) {
        for (let i = 0; i < 30; i += 1) {
          canvas = await capture({ fresh: true, preferRenderedFrame: true })
          if (canvas) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const activeItems = timeline.items.filter((item) => requestedFrame >= item.from && requestedFrame < item.from + item.durationInFrames)
        .map((item) => ({ id: item.id, label: item.label, type: item.type, text: (item as any).text, effects: item.effects?.map((effect) => effect.effect.gpuEffectType) }))
      const frameArtifact = canvas ? {
        id: `frame_${projectRevision.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}_${requestedFrame}`,
        mimeType: 'image/jpeg' as const, width: canvas.width, height: canvas.height,
        resourceRef: `sclip://frames/${requestedFrame}`, sourceRevision: projectRevision,
        sourceFrame: requestedFrame, sourceTime: Number((requestedFrame / Math.max(1, timeline.fps)).toFixed(3)),
      } : null
      const observationResult = await describeComposedFrame({
        frame: requestedFrame, fps: timeline.fps, projectRevision, frameArtifact, activeItems, timeoutMs: 60_000,
        captionFn: async () => {
          if (!canvas) return null
          const blob = canvas instanceof OffscreenCanvas
            ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
            : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
          if (!blob) return null
          const captions = await captionImage(blob)
          const caption = captions[0]
          return caption ? { text: caption.text, sceneData: caption.sceneData } : null
        },
      })
      reviews.push({ status: observationResult.status, reviewedFrame: requestedFrame, reviewedSeconds: Number((requestedFrame / Math.max(1, timeline.fps)).toFixed(3)), observation: observationResult.observation, evidence: observationResult.evidence, frameArtifact: observationResult.frameArtifact })
    }
    const verified = reviews.filter((review) => review.status === 'verified').length
    const first = reviews[0]!
    return {
      success: true, status: verified === reviews.length ? 'verified' : verified ? 'partial' : 'degraded', projectRevision,
      reviewedFrame: first.reviewedFrame, reviewedSeconds: first.reviewedSeconds, observation: first.observation,
      evidence: first.evidence, frameArtifact: first.frameArtifact, reviews,
      visualVerification: { status: verified === reviews.length ? 'verified' : 'degraded', currentRevision: projectRevision, lastReviewedRevision: projectRevision, requestedFrames, verifiedFrames: verified },
    }
  },

  // Import deliberately writes through FreeCut's media-library service, so the
  // result appears in the visible bin and can be used by video_add_clip. A
  // local path is copied into the project workspace; a URL is downloaded by
  // the existing FreeCut URL-import flow.
  video_import_media: async (args) => {
    const projectId = String(args.project_id || '')
    const source = String(args.source || '').trim()
    const sourceType = String(args.source_type || 'path')
    if (!projectId || !source) throw new Error('project_id and source are required')
    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_import_media')
    const { mediaLibraryService } = await import('@/features/media-library/services/media-library-service')
    let imported: { id: string; fileName: string; mimeType: string; duration: number }
    if (sourceType === 'url') {
      imported = await mediaLibraryService.importMediaFromUrl(source, projectId)
    } else if (sourceType === 'path') {
      const bytes = await invoke<number[]>('read_file_bytes', { path: source })
      const fileName = source.split('/').filter(Boolean).at(-1) || 'imported-media'
      const extension = fileName.split('.').at(-1)?.toLowerCase()
      const mimeType = ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', json: 'application/json', lottie: 'application/lottie+json' } as Record<string, string>)[extension ?? ''] ?? ''
      const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType })
      const handle = {
        kind: 'file',
        name: fileName,
        getFile: async () => file,
        queryPermission: async () => 'granted' as const,
        requestPermission: async () => 'granted' as const,
      } as unknown as FileSystemFileHandle
      imported = await mediaLibraryService.importMediaWithHandle(handle, projectId, { storageMode: 'copy' })
    } else {
      throw new Error('source_type must be path or url')
    }
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    return { success: true, projectId, media: { id: imported.id, fileName: imported.fileName, mimeType: imported.mimeType, duration: imported.duration } }
  },

  // Timeline operations
  video_add_clip: async (args) => {
    const mediaStore = useMediaLibraryStore.getState()
    const timeline = await prepareTimelineMutation(args.project_id, undefined, args.expected_revision, 'video_add_clip')
    assertTrackIsMutable(timeline, String(args.track_id), 'video_add_clip')

    // Ensure the project context is set so media gets loaded for this project.
    if (mediaStore.currentProjectId !== args.project_id) {
      await mediaStore.setCurrentProject(args.project_id)
    }
    // Load media items for the current project so mediaById is populated
    await mediaStore.loadMediaItems()
    
    // Re-read state in case it changed
    const mediaStore2 = useMediaLibraryStore.getState()
    const { addItem } = useTimelineStore.getState()
    // args: { project_id, media_id, track_id, from_frame, duration_frames }
    const media = mediaStore2.mediaById?.[args.media_id]
    if (!media) {
      throw new Error(`Media not found: ${args.media_id}`)
    }

    // Use FreeCut's own drag/drop item builder. Besides video it correctly
    // creates audio, image, and Lottie timeline items with their native
    // timing/transform metadata, preserving manual-editor/export behavior.
    const mediaType = getMediaType(media.mimeType)
    if (mediaType === 'unknown') throw new Error(`Unsupported SCLIP media type: ${media.mimeType}`)
    const blobUrl = await resolveMediaUrl(media.id)
    if (!blobUrl) throw new Error(`Unable to read media: ${media.fileName}`)
    const { fps } = useTimelineStore.getState()
    const project = useProjectStore.getState().currentProject
    const item = buildDroppedMediaTimelineItem({
      media,
      mediaId: media.id,
      mediaType,
      label: media.fileName,
      timelineFps: fps,
      blobUrl,
      canvasWidth: project?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
      canvasHeight: project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
      placement: {
        trackId: String(args.track_id),
        from: Math.max(0, Number(args.from_frame) || 0),
        durationInFrames: Math.max(1, Number(args.duration_frames) || 1),
      },
    })

    const sourceStartFrame = typeof args.source_start_frame === 'number'
      ? Math.max(0, Math.round(args.source_start_frame))
      : typeof args.source_start_sec === 'number'
        ? Math.max(0, Math.round(args.source_start_sec * fps))
        : 0

    if (sourceStartFrame > 0 && (item.type === 'video' || item.type === 'audio')) {
      const mediaItem = item as typeof item & { sourceStart?: number; sourceEnd?: number }
      mediaItem.sourceStart = sourceStartFrame
      mediaItem.sourceEnd = typeof args.source_end_frame === 'number'
        ? Math.max(sourceStartFrame + 1, Math.round(args.source_end_frame))
        : sourceStartFrame + item.durationInFrames
    }

    addItem(item)
    // Persist the timeline change to project.json.
    await useTimelineStore.getState().saveTimeline(args.project_id)
    return { itemId: item.id, itemType: item.type, success: true }
  },

  video_add_text: async (args) => {
    const projectId = String(args.project_id || '')
    const text = String(args.text || '').trim()
    if (!projectId) throw new Error('project_id is required')
    if (!text) throw new Error('text is required')

    // Join the open editor timeline, saving any manual work before Hermes
    // creates its layer.
    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_add_text')
    const project = await prepareProjectForAgent(projectId)

    const { tracks, items, fps, addItem } = useTimelineStore.getState()
    const preferredTrackId = typeof args.track_id === 'string' ? args.track_id : undefined
    const targetTrack = findCompatibleTrackForItemType({
      tracks,
      items,
      itemType: 'text',
      preferredTrackId,
    })
    if (!targetTrack) throw new Error('No compatible track is available for a text layer')

    const durationInFrames = Math.max(
      1,
      Number.isFinite(args.duration_frames)
        ? Math.round(args.duration_frames)
        : getDefaultGeneratedLayerDurationInFrames(fps),
    )
    const proposedFrom = Math.max(
      0,
      Number.isFinite(args.from_frame) ? Math.round(args.from_frame) : 0,
    )
    const from =
      findNearestAvailableSpace(proposedFrom, durationInFrames, targetTrack.id, items) ?? proposedFrom

    const item: TextItem = createTextTemplateItem({
      placement: {
        trackId: targetTrack.id,
        from,
        durationInFrames,
        canvasWidth: project.metadata.width ?? DEFAULT_PROJECT_WIDTH,
        canvasHeight: project.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
        fps,
      },
      text,
    })
    addItem(item)
    await useTimelineStore.getState().saveTimeline(projectId)
    return {
      success: true,
      itemId: item.id,
      trackId: item.trackId,
      fromFrame: item.from,
      durationFrames: item.durationInFrames,
    }
  },

  // FreeCut does not have a separate proprietary sticker media format. Emoji
  // stickers are real text-overlay layers, placed on their own track so they
  // remain visible concurrently with titles and footage.
  video_add_sticker: async (args) => {
    const projectId = String(args.project_id || '')
    const emoji = String(args.emoji || '').trim()
    if (!projectId) throw new Error('project_id is required')
    if (!emoji) throw new Error('emoji is required')

    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_add_sticker')
    const project = await prepareProjectForAgent(projectId)

    const { tracks, fps, addItemOnNewTrack } = useTimelineStore.getState()
    const overlayTrack = createOverlayLayerTrack({ tracks })
    if (!overlayTrack) throw new Error('No overlay track is available for the sticker')

    const durationInFrames = Math.max(
      1,
      Number.isFinite(args.duration_frames)
        ? Math.round(args.duration_frames)
        : getDefaultGeneratedLayerDurationInFrames(fps),
    )
    const from = Math.max(0, Number.isFinite(args.from_frame) ? Math.round(args.from_frame) : 0)
    const canvasWidth = project.metadata.width ?? DEFAULT_PROJECT_WIDTH
    const canvasHeight = project.metadata.height ?? DEFAULT_PROJECT_HEIGHT
    const size = Math.max(24, Math.min(640, Number.isFinite(args.size) ? Math.round(args.size) : 180))
    const x = Number.isFinite(args.x) ? Math.round(args.x) : 0
    const y = Number.isFinite(args.y) ? Math.round(args.y) : 0
    const item: TextItem = {
      ...createTextTemplateItem({
        placement: {
          trackId: overlayTrack.trackId,
          from,
          durationInFrames,
          canvasWidth,
          canvasHeight,
          fps,
        },
        text: emoji,
        label: `Sticker ${emoji}`,
      }),
      fontFamily: 'Noto Color Emoji',
      fontSize: size,
      transform: {
        x,
        y,
        width: size * 1.5,
        height: size * 1.5,
        rotation: 0,
        opacity: 1,
      },
    }

    addItemOnNewTrack(item, overlayTrack.tracks)
    await useTimelineStore.getState().saveTimeline(projectId)
    return {
      success: true,
      itemId: item.id,
      trackId: item.trackId,
      emoji,
      fromFrame: item.from,
      durationFrames: item.durationInFrames,
    }
  },

  // Shapes are native FreeCut timeline layers, not SVGs rendered by a hidden
  // SCLIP compositor. This makes shape animation, effects, selection, export,
  // undo and reopening behave exactly like a manually created shape.
  video_add_shape: async (args) => {
    const projectId = String(args.project_id || '')
    const shapeType = String(args.shape_type || 'rectangle') as ShapeType
    const preset = String(args.preset || 'default')
    const supported = new Set<ShapeType>(['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'])
    if (!projectId) throw new Error('project_id is required')
    if (!supported.has(shapeType)) throw new Error(`Unsupported SCLIP shape type: ${shapeType}`)
    if (!['default', 'solid', 'gradient'].includes(preset)) throw new Error('preset must be default, solid, or gradient')

    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_add_shape')
    const project = await prepareProjectForAgent(projectId)
    const { tracks, fps, addItemOnNewTrack } = useTimelineStore.getState()
    const overlayTrack = createOverlayLayerTrack({ tracks })
    if (!overlayTrack) throw new Error('No overlay track is available for the shape')
    const durationInFrames = Math.max(1, Number.isFinite(args.duration_frames)
      ? Math.round(args.duration_frames)
      : getDefaultGeneratedLayerDurationInFrames(fps))
    const placement = {
      trackId: overlayTrack.trackId,
      from: Math.max(0, Number.isFinite(args.from_frame) ? Math.round(args.from_frame) : 0),
      durationInFrames,
      canvasWidth: project.metadata.width ?? DEFAULT_PROJECT_WIDTH,
      canvasHeight: project.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
    }
    const item = preset === 'solid'
      ? createDefaultSolidColorItem(placement)
      : preset === 'gradient'
        ? createDefaultGradientItem(placement)
        : createDefaultShapeItem({ ...placement, shapeType })
    if (args.style && typeof args.style === 'object') {
      Object.assign(item, primitiveParams(args.style))
    }
    addItemOnNewTrack(item, overlayTrack.tracks)
    await saveTimelineMutation(projectId)
    return { success: true, itemId: item.id, trackId: item.trackId, shapeType: item.shapeType }
  },

  video_split: async (args) => {
    const expectedRevision = args.expected_revision ?? args.expectedRevision
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, expectedRevision, 'video_split') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    // args: { project_id, item_id, frame }
    const result = await timeline.splitItem(args.item_id, args.frame)
    await saveTimelineMutation(args.project_id)
    return { splitCount: result, success: true }
  },

  video_trim: async (args) => {
    const expectedRevision = args.expected_revision ?? args.expectedRevision
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, expectedRevision, 'video_trim') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    // args: { project_id, item_id, trim_start?, trim_end? }
    if (args.trim_start !== undefined) {
      await timeline.trimItemStart(args.item_id, args.trim_start)
    }
    if (args.trim_end !== undefined) {
      await timeline.trimItemEnd(args.item_id, args.trim_end)
    }
    await saveTimelineMutation(args.project_id)
    return { success: true }
  },

  video_move: async (args) => {
    const expectedRevision = args.expected_revision ?? args.expectedRevision
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, expectedRevision, 'video_move') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    // args: { project_id, item_id, new_from_frame, new_track_id? }
    await timeline.moveItem(args.item_id, args.new_from_frame, args.new_track_id)
    await saveTimelineMutation(args.project_id)
    return { success: true }
  },

  video_remove: async (args) => {
    const expectedRevision = args.expected_revision ?? args.expectedRevision
    const timeline = await prepareTimelineMutation(args.project_id, undefined, expectedRevision, 'video_remove') as ReturnType<typeof useTimelineStore.getState>
    // args: { project_id, item_ids }
    for (const itemId of args.item_ids) {
      const item = timeline.items.find((candidate) => candidate.id === itemId)
      if (!item) throw new Error(`Timeline item not found: ${itemId}`)
      assertTrackIsMutable(timeline, item.trackId, 'video_remove')
    }
    timeline.removeItems(args.item_ids)
    await saveTimelineMutation(args.project_id)
    return { success: true, removedCount: args.item_ids.length }
  },

  video_add_transition: async (args) => {
    const timeline = await prepareTimelineMutation(args.project_id, undefined, args.expected_revision, 'video_add_transition')
    const presentation = String(args.transition_type || '').trim()
    if (!GPU_TRANSITION_REGISTRY.has(presentation)) {
      throw new Error(`Unknown SCLIP transition: ${presentation}. Call video_editor_capabilities first.`)
    }
    const leftItem = timeline.items.find((item) => item.id === args.from_item_id)
    const rightItem = timeline.items.find((item) => item.id === args.to_item_id)
    if (!leftItem || !rightItem) throw new Error('Transition items not found')
    assertTrackIsMutable(timeline, leftItem.trackId, 'video_add_transition')
    assertTrackIsMutable(timeline, rightItem.trackId, 'video_add_transition')
    const requestedDuration = Number(args.duration_frames)
    const validation = canAddTransition(
      leftItem,
      rightItem,
      requestedDuration,
      0.5,
      timeline.fps,
      true,
    )
    if (!validation.canAdd) {
      throw new Error(JSON.stringify({
        code: 'TRANSITION_DURATION_UNAVAILABLE',
        requestedDuration,
        operation: 'video_add_transition',
        reason: validation.reason,
      }))
    }
    // FreeCut stores one logical transition type (crossfade) plus a GPU
    // presentation. Passing the presentation as the type was the reason
    // Hermes got false results for valid names such as dissolve or fade.
    const success = timeline.addTransition(
      args.from_item_id,
      args.to_item_id,
      'crossfade',
      args.duration_frames,
      presentation as never,
    )
    if (success) {
      await saveTimelineMutation(args.project_id)
    }
    return success
      ? { success: true, presentation }
      : { success: false, presentation, reason: 'Clips must be compatible, adjacent or overlap-valid, on the same usable timeline, and have sufficient source handles.' }
  },

  video_add_effect: async (args) => {
    const { timeline, item } = await prepareTimelineMutation(args.project_id, args.item_id, args.expected_revision, 'video_add_effect') as {
      timeline: ReturnType<typeof useTimelineStore.getState>
      item: { type: string; effects?: Array<{ id: string }> }
    }
    if (item.type === 'audio') throw new Error('Visual effects cannot be added to an audio-only item')
    const effectType = normalizeEffectType(args.effect_type)
    if (!getGpuEffect(effectType)) throw new Error(`Unknown SCLIP effect: ${effectType}`)
    const effect: VisualEffect = {
      type: 'gpu-effect',
      gpuEffectType: effectType,
      params: { ...getGpuEffectDefaultParams(effectType), ...primitiveParams(args.params ?? {}) },
    }
    timeline.addEffect(args.item_id, effect)
    await saveTimelineMutation(args.project_id)
    const savedItem = useTimelineStore.getState().items.find((candidate) => candidate.id === args.item_id)
    const added = savedItem?.effects?.at(-1)
    return { success: true, effectId: added?.id, effectType }
  },

  video_manage_effect: async (args) => {
    const { timeline, item } = await prepareTimelineMutation(args.project_id, args.item_id, args.expected_revision, 'video_manage_effect') as {
      timeline: ReturnType<typeof useTimelineStore.getState>
      item: { effects?: Array<{ id: string; effect: VisualEffect; enabled: boolean }> }
    }
    const existing = item.effects?.find((effect) => effect.id === args.effect_id)
    if (!existing) throw new Error(`Effect not found: ${args.effect_id}`)
    if (args.action === 'remove') {
      timeline.removeEffect(args.item_id, args.effect_id)
    } else if (args.action === 'toggle') {
      timeline.toggleEffect(args.item_id, args.effect_id)
    } else if (args.action === 'update') {
      const updates = args.updates ?? {}
      const effectType = updates.effect_type ? normalizeEffectType(updates.effect_type) : existing.effect.gpuEffectType
      if (!getGpuEffect(effectType)) throw new Error(`Unknown SCLIP effect: ${effectType}`)
      timeline.updateEffect(args.item_id, args.effect_id, {
        ...(typeof updates.enabled === 'boolean' ? { enabled: updates.enabled } : {}),
        effect: {
          type: 'gpu-effect',
          gpuEffectType: effectType,
          params: { ...getGpuEffectDefaultParams(effectType), ...existing.effect.params, ...primitiveParams(updates.params ?? {}) },
        },
      })
    } else {
      throw new Error('action must be update, toggle, or remove')
    }
    await saveTimelineMutation(args.project_id)
    return { success: true, itemId: args.item_id, effectId: args.effect_id, action: args.action }
  },

  // Generic native-item editing for text styling, audio gain/fades/ducking,
  // clip speed and other project fields. Validated strictly against canonical
  // contracts (no silent corruption).
  video_update_item: async (args) => {
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, args.expected_revision, 'video_update_item') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    const allowed = new Set([
      'label', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color',
      'backgroundColor', 'textAlign', 'letterSpacing', 'lineHeight', 'strokeColor',
      'strokeWidth', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
      'volume', 'muted', 'audioFadeIn', 'audioFadeOut', 'audioFadeInCurve',
      'audioFadeOutCurve', 'audioPitchSemitones', 'audioPitchCents', 'audioDucking',
      'fadeIn', 'fadeOut', 'speed', 'isReversed', 'visible', 'locked', 'blendMode',
    ])
    const rawUpdates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args.updates ?? {})) {
      if (!allowed.has(key)) throw new Error(`Unsupported editable item field: ${key}`)
      rawUpdates[key] = value
    }
    if (Object.keys(rawUpdates).length === 0) throw new Error('updates must contain at least one supported field')

    const validation = validateItemUpdates(rawUpdates, true)

    timeline.updateItem(args.item_id, validation.sanitizedUpdates as never)
    await saveTimelineMutation(args.project_id)
    return {
      success: true,
      itemId: args.item_id,
      updatedFields: Object.keys(validation.sanitizedUpdates),
      ...(Object.keys(validation.normalizedFields).length ? { normalizedFields: validation.normalizedFields } : {}),
    }
  },

  video_update_transform: async (args) => {
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, args.expected_revision, 'video_update_transform') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    const rawTransform = (args.transform && typeof args.transform === 'object') ? args.transform : {}
    if (Object.keys(rawTransform).length === 0) throw new Error('transform must contain at least one field')

    const validation = validateTransformUpdates(rawTransform, true)

    timeline.updateItemTransform(args.item_id, validation.sanitizedTransform as never)
    await saveTimelineMutation(args.project_id)
    return {
      success: true,
      itemId: args.item_id,
      transform: validation.sanitizedTransform,
      ...(Object.keys(validation.normalizedFields).length ? { normalizedFields: validation.normalizedFields } : {}),
    }
  },

  video_add_keyframe: async (args) => {
    const { timeline } = await prepareTimelineMutation(args.project_id, args.item_id, args.expected_revision, 'video_add_keyframe') as { timeline: ReturnType<typeof useTimelineStore.getState> }
    if (!Number.isFinite(args.frame) || !Number.isFinite(args.value)) throw new Error('frame and value must be numbers')
    const keyframeId = timeline.addKeyframe(args.item_id, String(args.property) as never, args.frame, args.value, args.easing)
    await saveTimelineMutation(args.project_id)
    return { success: true, keyframeId, itemId: args.item_id }
  },

  video_manage_transition: async (args) => {
    const timeline = await prepareTimelineMutation(args.project_id, undefined, args.expected_revision, 'video_manage_transition')
    const transition = timeline.transitions.find((candidate) => candidate.id === args.transition_id)
    if (!transition) throw new Error(`Transition not found: ${args.transition_id}`)
    if (args.action === 'remove') {
      timeline.removeTransition(args.transition_id)
    } else if (args.action === 'update') {
      timeline.updateTransition(args.transition_id, args.updates ?? {})
    } else {
      throw new Error('action must be update or remove')
    }
    await saveTimelineMutation(args.project_id)
    return { success: true, transitionId: args.transition_id, action: args.action }
  },

  video_timeline_edit: async (args) => {
    const timeline = await prepareTimelineMutation(args.project_id, undefined, args.expected_revision, 'video_timeline_edit')
    const values = args.values ?? {}
    switch (args.action) {
      case 'ripple_delete':
        timeline.rippleDeleteItems(values.item_ids ?? [])
        break
      case 'reverse':
        timeline.reverseItems(values.item_ids ?? [])
        break
      case 'close_gap':
        timeline.closeGapAtPosition(String(values.track_id), Number(values.frame))
        break
      case 'set_in_out':
        if (Number.isFinite(values.in_frame)) timeline.setInPoint(values.in_frame)
        if (Number.isFinite(values.out_frame)) timeline.setOutPoint(values.out_frame)
        break
      case 'clear_in_out':
        timeline.clearInOutPoints()
        break
      case 'rate_stretch':
        timeline.rateStretchItem(String(values.item_id), Number(values.from_frame), Number(values.duration_frames), Number(values.speed))
        break
      case 'remove_silence':
        timeline.removeSilenceFromItems(
          Array.isArray(values.item_ids) ? values.item_ids.map(String) : [],
          values.ranges_by_media_id ?? {},
        )
        break
      case 'remove_filler_words':
        timeline.removeFillerWordsFromItems(
          Array.isArray(values.item_ids) ? values.item_ids.map(String) : [],
          values.ranges_by_media_id ?? {},
        )
        break
      default:
        throw new Error('Unsupported timeline action')
    }
    await saveTimelineMutation(args.project_id)
    return { success: true, action: args.action }
  },

  // Deterministic FreeCut audio analysis. This never changes the timeline and
  // keeps the crucial distinction between waveform silence and transcript gaps.
  video_analyze_audio: async (args) => {
    const projectId = String(args.project_id || '')
    const itemIds = Array.isArray(args.item_ids) ? args.item_ids.map(String) : []
    if (!projectId || !itemIds.length) throw new Error('project_id and non-empty item_ids are required')
    await prepareProjectForAgent(projectId)
    const timeline = useTimelineStore.getState()
    const validItems = itemIds.map((id) => timeline.items.find((item) => item.id === id)).filter(Boolean)
    if (validItems.length !== itemIds.length) throw new Error('One or more item_ids are not present on the live timeline')
    if (validItems.some((item) => item!.type !== 'audio' && item!.type !== 'video')) {
      throw new Error('Audio analysis requires audio or video timeline items')
    }
    if (args.mode === 'boundary' && args.boundary && typeof args.boundary === 'object') {
      const { analyzeAudioBoundary } = await import('@/perception')
      const b = args.boundary as Record<string, unknown>
      const boundaryInspection = analyzeAudioBoundary({
        outgoingMediaId: String(b.outgoing_media_id || validItems[0]?.mediaId || ''),
        outgoingTimeSec: Number(b.outgoing_time_sec ?? 0),
        outgoingRmsDb: typeof b.outgoing_rms_db === 'number' ? b.outgoing_rms_db : undefined,
        outgoingNoiseFloorDb: typeof b.outgoing_noise_floor_db === 'number' ? b.outgoing_noise_floor_db : undefined,
        outgoingHasSpeech: typeof b.outgoing_has_speech === 'boolean' ? b.outgoing_has_speech : undefined,
        outgoingHasBreathTail: typeof b.outgoing_has_breath_tail === 'boolean' ? b.outgoing_has_breath_tail : undefined,
        incomingMediaId: String(b.incoming_media_id || validItems[1]?.mediaId || validItems[0]?.mediaId || ''),
        incomingTimeSec: Number(b.incoming_time_sec ?? 0),
        incomingRmsDb: typeof b.incoming_rms_db === 'number' ? b.incoming_rms_db : undefined,
        incomingNoiseFloorDb: typeof b.incoming_noise_floor_db === 'number' ? b.incoming_noise_floor_db : undefined,
        incomingHasSpeech: typeof b.incoming_has_speech === 'boolean' ? b.incoming_has_speech : undefined,
        incomingHasBreathOnset: typeof b.incoming_has_breath_onset === 'boolean' ? b.incoming_has_breath_onset : undefined,
      })
      return {
        success: true,
        projectId,
        itemIds,
        mode: 'boundary',
        inspection: boundaryInspection,
      }
    }

    const { analyzeSilenceForItems, normalizeSilenceRemovalSettings } = await import('@/features/timeline/utils/silence-removal-preview')
    const rawSettings = args.settings && typeof args.settings === 'object' ? args.settings as Record<string, unknown> : {}
    const settings = normalizeSilenceRemovalSettings({
      mode: args.mode === 'speech' ? 'speech' : 'signal',
      ...(typeof rawSettings.autoThresholds === 'boolean' ? { autoThresholds: rawSettings.autoThresholds } : {}),
      ...(['thresholdDb', 'audioThresholdDb', 'minSilenceMs', 'minAudioMs', 'paddingStartMs', 'paddingEndMs', 'smoothingMs', 'windowMs']
        .reduce<Record<string, number>>((result, key) => {
          if (typeof rawSettings[key] === 'number' && Number.isFinite(rawSettings[key])) result[key] = rawSettings[key] as number
          return result
        }, {})),
    })
    const analysis = await analyzeSilenceForItems(itemIds, settings)
    const totalSeconds = Object.values(analysis.rangesByMediaId).flat().reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
    return {
      success: true, applied: false, projectId, itemIds, mode: settings.mode, settings, analysis,
      totalCandidateSeconds: Number(totalSeconds.toFixed(3)),
      limitations: settings.mode === 'speech'
        ? ['Speech mode identifies gaps between timestamped transcript words; it does not inspect waveform loudness.']
        : ['Signal mode identifies low-level waveform ranges; the creator must still preserve intentional pauses, breaths, and musical beats.'],
      nextStep: 'Review these source-time candidates. If the creator approves a specific set, pass exactly those ranges to video_timeline_edit action=remove_silence; that edit remains undoable.',
    }
  },

  // Uses the same command history as the editor toolbar. Agent changes are
  // therefore reversible by both Hermes and the human collaborating on the
  // project, after which the restored state is durably saved.
  video_history: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || '')
    if (!projectId || !['undo', 'redo'].includes(action)) throw new Error('project_id and action (undo or redo) are required')
    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_history')
    const history = useTimelineStore.temporal.getState()
    const available = action === 'undo' ? history.pastStates.length : history.futureStates.length
    if (available === 0) throw new Error(`Nothing available to ${action}`)
    if (action === 'undo') history.undo()
    else history.redo()
    await saveTimelineMutation(projectId)
    return { success: true, action, remaining: action === 'undo' ? useTimelineStore.temporal.getState().pastStates.length : useTimelineStore.temporal.getState().futureStates.length }
  },

  // Proxy generation and relinking use FreeCut's existing media service. A
  // relink target must be an absolute path, which we turn into the same
  // FileSystemFileHandle-shaped capability the desktop import route uses.
  video_manage_media: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    const action = String(args.action || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')
    if (action === 'relink') {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_manage_media.relink')
    } else {
      await prepareProjectForAgent(projectId)
    }
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    const media = useMediaLibraryStore.getState().mediaById[mediaId]
    if (!media) throw new Error(`Media not found in project: ${mediaId}`)

    if (action === 'generate_proxy') {
      if (!proxyService.canGenerateProxy(media.mimeType)) throw new Error('Only video media can have a proxy')
      const proxyKey = getSharedProxyKey(media)
      proxyService.setProxyKey(media.id, proxyKey)
      proxyService.generateProxy(
        media.id,
        media.storageType === 'opfs' && media.opfsPath
          ? { kind: 'opfs', path: media.opfsPath, mimeType: media.mimeType }
          : async () => {
              const { mediaLibraryService } = await import('@/features/media-library/services/media-library-service')
              return mediaLibraryService.getMediaFile(media.id)
            },
        media.width,
        media.height,
        proxyKey,
      )
      return { success: true, action, mediaId, status: 'generating' }
    }
    if (action === 'cancel_proxy') {
      proxyService.cancelProxy(media.id, getSharedProxyKey(media))
      return { success: true, action, mediaId, status: 'idle' }
    }
    if (action === 'relink') {
      const source = String(args.source || '').trim()
      if (!source) throw new Error('source is required to relink media')
      const bytes = await invoke<number[]>('read_file_bytes', { path: source })
      const fileName = source.split('/').filter(Boolean).at(-1) || media.fileName
      const file = new File([new Uint8Array(bytes)], fileName, { type: media.mimeType })
      const handle = { kind: 'file', name: fileName, getFile: async () => file, queryPermission: async () => 'granted' as const, requestPermission: async () => 'granted' as const } as unknown as FileSystemFileHandle
      const success = await useMediaLibraryStore.getState().relinkMedia(mediaId, handle)
      if (!success) throw new Error(`SCLIP could not relink media: ${mediaId}`)
      await saveTimelineMutation(projectId)
      return { success: true, action, mediaId, fileName }
    }
    throw new Error('action must be generate_proxy, cancel_proxy, or relink')
  },

  // This is deliberately a small structured companion to Hermes's own SCLIP
  // user-profile memory. It gives editing decisions stable fields that can be
  // reused across projects without exposing or altering personal Hermes data.
  video_editing_memory: async (args) => {
    const action = String(args.action || 'get')
    const projectId = typeof args.project_id === 'string' ? args.project_id : undefined
    if (!['get', 'update_preferences', 'set_project_context', 'record_feedback'].includes(action)) {
      throw new Error('Unsupported editing memory action')
    }
    const result = await invoke('sclip_editing_memory', {
      action,
      projectId,
      values: args.values && typeof args.values === 'object' ? args.values : undefined,
      feedback: typeof args.feedback === 'string' ? args.feedback : undefined,
    })
    return result
  },

  // Persistent recovery points live inside the isolated SCLIP profile. The
  // project object is first flushed from the same timeline that is on screen,
  // and restore rehydrates that same visible project—never a shadow timeline.
  video_project_snapshot: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || 'list')
    if (!projectId || !['create', 'list', 'restore'].includes(action)) {
      throw new Error('project_id and action (create, list, or restore) are required')
    }
    if (action === 'restore') {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_project_snapshot.restore')
    } else {
      await prepareProjectForAgent(projectId)
    }
    if (action === 'create') {
      const { getProject } = await import('@/infrastructure/storage')
      const project = await getProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      return invoke('sclip_project_snapshot', {
        action: 'create', projectId, label: typeof args.label === 'string' ? args.label : undefined, project,
      })
    }
    if (action === 'list') {
      return invoke('sclip_project_snapshot', { action: 'list', projectId })
    }
    const snapshotId = String(args.snapshot_id || '')
    if (!snapshotId) throw new Error('snapshot_id is required to restore a snapshot')
    const saved = await invoke<{ project: unknown }>('sclip_project_snapshot', {
      action: 'get', projectId, snapshotId,
    })
    const restored = saved.project as { id?: string }
    if (!restored || restored.id !== projectId) throw new Error('Snapshot does not belong to this project')
    const { updateProject } = await import('@/infrastructure/storage')
    await updateProject(projectId, restored as never)
    await useProjectStore.getState().loadProject(projectId)
    await useTimelineStore.getState().loadTimeline(projectId)
    return { success: true, projectId, snapshotId }
  },

  // Generates local audio through FreeCut's actual WebGPU services, imports
  // the resulting file into the visible project media library, and optionally
  // inserts it as a normal editable audio clip. This is intentionally not a
  // hidden audio renderer or an external generation shortcut.
  video_generate_audio: async (args) => {
    const projectId = String(args.project_id || '')
    const kind = String(args.kind || '')
    const prompt = String(args.prompt || '').trim()
    if (!projectId || !['music', 'speech'].includes(kind) || !prompt) {
      throw new Error('project_id, kind (music or speech), and prompt are required')
    }
    if (args.insert !== false) {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_generate_audio.insert')
    } else {
      await prepareProjectForAgent(projectId)
    }
    let file: File
    let blob: Blob
    let duration: number
    let tags: string[]
    if (kind === 'music') {
      const { musicgenService, DEFAULT_MUSICGEN_MODEL } = await import('@/features/editor/services/musicgen-service')
      const result = await musicgenService.generateMusicFile({
        prompt,
        model: args.model || DEFAULT_MUSICGEN_MODEL,
        durationSeconds: Math.max(1, Math.min(30, Number(args.duration_seconds) || 10)),
      })
      ;({ file, blob, duration } = result)
      tags = ['ai-generated', 'musicgen', `musicgen-prompt:${prompt.slice(0, 80)}`]
    } else {
      const {
        kokoroTtsService,
        KOKORO_TTS_BEST_MODEL,
        KOKORO_TTS_VOICE_OPTIONS,
      } = await import('@/features/editor/services/kokoro-tts-service')
      const result = await kokoroTtsService.generateSpeechFile({
        text: prompt,
        voice: args.voice || KOKORO_TTS_VOICE_OPTIONS[0]?.value,
        speed: Math.max(0.5, Math.min(2, Number(args.speed) || 1)),
        model: args.model || KOKORO_TTS_BEST_MODEL,
      })
      ;({ file, blob, duration } = result)
      tags = ['ai-generated', 'voiceover', 'kokoro-tts']
    }
    const { mediaLibraryService } = await import('@/features/media-library/services/media-library-service')
    const media = await mediaLibraryService.importGeneratedAudio(file, projectId, { tags })
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    let itemId: string | undefined
    if (args.insert !== false) {
      const { insertGeneratedAudioOnNewTrack } = await import('@/features/editor/utils/insert-generated-audio')
      const beforeIds = new Set(useTimelineStore.getState().items.map((item) => item.id))
      const objectUrl = URL.createObjectURL(blob)
      const inserted = insertGeneratedAudioOnNewTrack(media, objectUrl, Number(args.from_frame) || 0)
      if (!inserted) throw new Error('Generated audio was imported, but SCLIP could not insert it on the timeline')
      itemId = useTimelineStore.getState().items.find((item) => !beforeIds.has(item.id))?.id
      await saveTimelineMutation(projectId)
    }
    return { success: true, kind, mediaId: media.id, fileName: media.fileName, duration, itemId }
  },

  video_render: async (args) => {
    const { buildRenderJob } = await import('@/features/export/utils/build-render-job')
    const { useRenderQueueStore } = await import('@/features/export/stores/render-queue-store')
    await prepareTimelineMutation(args.project_id, undefined, args.expected_revision, 'video_render')
    const project = await prepareProjectForAgent(args.project_id)
    const preset = String(args.preset || 'recommended')
    const presets = {
      max: { quality: 'ultra', scale: 1 },
      recommended: { quality: 'medium', scale: 1 },
      balanced: { quality: 'medium', scale: 0.666 },
      small: { quality: 'low', scale: 0.5 },
    } as const
    const selectedPreset = presets[preset as keyof typeof presets]
    if (!selectedPreset) throw new Error('preset must be max, recommended, balanced, or small')
    const codec = ['h264', 'h265', 'vp8', 'vp9', 'av1', 'prores'].includes(args.codec)
      ? args.codec
      : 'h264'
    const container = ['mp4', 'mov', 'webm', 'mkv'].includes(args.container)
      ? args.container
      : 'mp4'
    const quality = ['low', 'medium', 'high', 'ultra'].includes(args.quality)
      ? args.quality
      : selectedPreset.quality
    const scale = selectedPreset.scale
    const settings = {
      codec: codec as 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'prores',
      quality: quality as 'low' | 'medium' | 'high' | 'ultra',
      resolution: {
        width: Math.max(2, Math.round(project.metadata.width * scale)),
        height: Math.max(2, Math.round(project.metadata.height * scale)),
      },
      rateControl: 'auto' as const,
      mode: 'video' as const,
      videoContainer: container as 'mp4' | 'mov' | 'webm' | 'mkv',
      subtitleMode: ['off', 'burn', 'sidecar', 'embedded'].includes(args.subtitle_mode)
        ? args.subtitle_mode as 'off' | 'burn' | 'sidecar' | 'embedded'
        : 'burn' as const,
    }
    const name = typeof args.output_name === 'string' && args.output_name.trim()
      ? args.output_name.trim()
      : `${project.name}-${preset}`
    const job = await buildRenderJob({ settings, name })
    useRenderQueueStore.getState().enqueueJobs([job])
    return {
      success: true,
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      preset,
      settings,
      note: 'Render job enqueued. Poll video_render_status until it completes, fails, or is cancelled.',
    }
  },

  video_get_project_summary: async (args) => {
    const projectId = String(args.project_id || '')
    if (!projectId) throw new Error('project_id is required')
    const project = await prepareProjectForAgent(projectId)
    const timeline = useTimelineStore.getState()
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()

    const mediaList = Object.values(mediaStore.mediaById)
    const { getTranscript } = await import('@/infrastructure/storage')
    const { buildProjectSummary } = await import('@/perception')

    const transcriptEntries = await Promise.all(
      mediaList.map(async (m) => {
        const transcript = await getTranscript(m.id).catch(() => null)
        return [m.id, transcript?.segments ?? []] as const
      }),
    )
    const transcriptSegmentsByMediaId = Object.fromEntries(transcriptEntries)

    const visualMomentsByMediaId: Record<string, Array<{ timeSec: number; text: string; scene?: any }>> = {}
    for (const m of mediaList) {
      if (m.aiCaptions?.length) {
        visualMomentsByMediaId[m.id] = m.aiCaptions.map((c) => ({
          timeSec: c.timeSec,
          text: c.text,
          scene: c.sceneData,
        }))
      }
    }

    const revision = getLiveProjectRevision(project)
    return buildProjectSummary({
      projectId: project.id,
      projectName: project.name,
      projectRevision: revision,
      fps: timeline.fps,
      width: project.metadata.width,
      height: project.metadata.height,
      tracks: timeline.tracks,
      items: timeline.items.map((it) => ({
        id: it.id,
        type: it.type,
        trackId: it.trackId,
        from: it.from,
        durationInFrames: it.durationInFrames,
        mediaId: it.mediaId,
      })),
      markersCount: timeline.markers?.length ?? 0,
      mediaMetadata: mediaList.map((m) => ({
        id: m.id,
        hasTranscript: (transcriptSegmentsByMediaId[m.id]?.length ?? 0) > 0,
        hasVisualAnalysis: (visualMomentsByMediaId[m.id]?.length ?? 0) > 0,
        duration: m.duration,
      })),
      transcriptSegmentsByMediaId,
      visualMomentsByMediaId,
    })
  },

  video_get_timeline_window: async (args) => {
    const projectId = String(args.project_id || '')
    if (!projectId) throw new Error('project_id is required')
    const startSec = Number(args.start_sec ?? args.startSec ?? 0)
    if (!Number.isFinite(startSec) || startSec < 0) {
      throw new Error('start_sec must be a non-negative number')
    }
    const endSec = typeof args.end_sec === 'number' ? args.end_sec : typeof args.endSec === 'number' ? args.endSec : startSec + 30
    if (!Number.isFinite(endSec) || endSec <= startSec) {
      throw new Error('end_sec must be a number greater than start_sec')
    }

    const project = await prepareProjectForAgent(projectId)
    const timeline = useTimelineStore.getState()
    const revision = getLiveProjectRevision(project)
    const { buildTimelineWindow } = await import('@/perception')

    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()

    const { getTranscript } = await import('@/infrastructure/storage')
    const relevantItems = timeline.items.filter((item) => {
      const fps = Math.max(1, timeline.fps)
      const itemStart = item.from / fps
      const itemEnd = (item.from + item.durationInFrames) / fps
      return itemStart < endSec && itemEnd > startSec
    })

    const mediaIds = Array.from(new Set(relevantItems.flatMap((it) => (it.mediaId ? [it.mediaId] : []))))
    const transcriptEntries = await Promise.all(
      mediaIds.map(async (id) => [id, await getTranscript(id).catch(() => null)] as const),
    )
    const transcriptsByMediaId = Object.fromEntries(transcriptEntries.map(([id, t]) => [id, t]))

    const { buildTranscriptTokens } = await import('@/features/editor/deps/timeline-contract')
    const transcriptTokens = buildTranscriptTokens(relevantItems, transcriptsByMediaId, timeline.fps)

    const visualMomentsByMediaId: Record<string, any[]> = {}
    for (const id of mediaIds) {
      const media = mediaStore.mediaById[id]
      if (media?.aiCaptions?.length) {
        visualMomentsByMediaId[id] = media.aiCaptions.map((c) => ({
          timeSec: c.timeSec,
          text: c.text,
          scene: c.sceneData,
        }))
      }
    }

    return buildTimelineWindow({
      projectId: project.id,
      projectRevision: revision,
      fps: timeline.fps,
      options: {
        startSec,
        endSec,
        tracks: Array.isArray(args.tracks) ? args.tracks.map(String) : undefined,
        detailLevel: args.detail_level === 'deep' ? 'deep' : args.detail_level === 'summary' ? 'summary' : 'standard',
        includeTranscript: args.include_transcript !== false,
        includeVisual: args.include_visual !== false,
        includeAudio: args.include_audio === true,
        maxItems: typeof args.max_items === 'number' ? args.max_items : undefined,
        maxWords: typeof args.max_words === 'number' ? args.max_words : undefined,
      },
      tracks: timeline.tracks,
      items: timeline.items.map((it) => {
        const raw = it as unknown as Record<string, unknown>
        return {
          id: it.id,
          type: it.type,
          trackId: it.trackId,
          from: it.from,
          durationInFrames: it.durationInFrames,
          label: it.label,
          mediaId: it.mediaId,
          text: it.text,
          sourceStart: typeof raw.sourceStart === 'number' ? raw.sourceStart : undefined,
          sourceDuration: typeof raw.sourceDuration === 'number' ? raw.sourceDuration : undefined,
          transform: raw.transform as Record<string, unknown> | undefined,
          effects: it.effects?.map((e) => ({ id: e.id })),
        }
      }),
      transcriptTokens,
      visualMomentsByMediaId,
    })
  },

  video_inspect_segment: async (args) => {
    const projectId = String(args.project_id || '')
    const itemId = typeof args.item_id === 'string' ? args.item_id : undefined
    const mediaId = typeof args.media_id === 'string' ? args.media_id : undefined
    if (!projectId || (!itemId && !mediaId)) {
      throw new Error('project_id and either item_id or media_id are required')
    }
    const project = await prepareProjectForAgent(projectId)
    const timeline = useTimelineStore.getState()
    const revision = getLiveProjectRevision(project)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()

    const item = itemId ? timeline.items.find((it) => it.id === itemId) : undefined
    const resolvedMediaId = mediaId || item?.mediaId
    const media = resolvedMediaId ? mediaStore.mediaById[resolvedMediaId] : undefined

    const { getTranscript } = await import('@/infrastructure/storage')
    const transcript = resolvedMediaId ? await getTranscript(resolvedMediaId).catch(() => null) : null

    return {
      projectId: project.id,
      projectRevision: revision,
      itemId,
      mediaId: resolvedMediaId,
      timelineItem: item,
      mediaMetadata: media
        ? {
            id: media.id,
            name: media.name,
            duration: media.duration,
            width: media.width,
            height: media.height,
            fps: media.fps,
            mimeType: media.mimeType,
          }
        : undefined,
      transcriptSegmentCount: transcript?.segments?.length ?? 0,
      visualCaptionsCount: media?.aiCaptions?.length ?? 0,
      visualCaptions: media?.aiCaptions,
      effects: item?.effects,
    }
  },

  video_get_project: async (args) => {
    const project = await prepareProjectForAgent(args.project_id)
    // Preserve the project fields used by earlier clients, but deliberately
    // replace its potentially stale persisted timeline with the live editor
    // state Hermes must plan from.
    return { ...project, timeline: buildLiveTimelineInspection(project) }
  },

  // The agent must ask the editor for its imported media instead of scraping
  // workspace files and guessing ids. The media library is the source of truth
  // for which items are available to place on this project's timeline.
  video_list_media: async (args) => {
    const projectId = String(args.project_id || '')
    if (!projectId) throw new Error('project_id is required')

    // Hydrate the exact project first. Without this, a fresh SCLIP session can
    // query the previous project's empty in-memory bin until the user clicks a
    // media card or otherwise causes the UI to hydrate it.
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) {
      mediaStore.setCurrentProject(projectId)
    }
    await useMediaLibraryStore.getState().loadMediaItems()

    const timelineItems = useTimelineStore.getState().items

    return {
      projectId,
      media: useMediaLibraryStore.getState().mediaItems.map((item) => {
        const placements = timelineItems.filter((ti) => ti.mediaId === item.id || ti.assetId === item.id)
        return {
          id: item.id,
          fileName: item.fileName,
          mimeType: item.mimeType,
          duration: item.duration,
          width: item.width,
          height: item.height,
          fps: item.fps,
          isOnTimeline: placements.length > 0,
          placementCount: placements.length,
          placements: placements.map((ti) => ({
            itemId: ti.id,
            trackId: ti.trackId,
            fromFrame: ti.from,
            durationFrames: ti.durationInFrames,
            sourceStart: ti.sourceStart,
            sourceEnd: ti.sourceEnd,
          })),
        }
      }),
    }
  },

  // Local B-roll retrieval. The result carries the exact evidence that
  // matched so a model can distinguish an analysed candidate from a filename
  // hint and ask before placing anything on the visible timeline.
  video_search_media: async (args) => {
    const projectId = String(args.project_id || '')
    const query = String(args.query || '').trim()
    if (!projectId || !query) throw new Error('project_id and query are required')
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()
    const { searchLocalMedia } = await import('@/features/media-library/utils/local-media-search')
    const matches = searchLocalMedia(mediaStore.mediaItems, query, Number(args.max_results) || 12)
    const timelineItems = useTimelineStore.getState().items
    const mediaById = mediaStore.mediaById
    return {
      success: true,
      projectId,
      query,
      searchMode: 'local_evidence_keyword',
      resultCount: matches.length,
      results: matches.map((match) => {
        const media = mediaById[match.mediaId]!
        const placements = timelineItems.filter((item) => item.mediaId === match.mediaId || item.assetId === match.mediaId)
        return {
          mediaId: match.mediaId,
          fileName: media.fileName,
          mimeType: media.mimeType,
          duration: media.duration,
          isOnTimeline: placements.length > 0,
          placementCount: placements.length,
          score: match.score,
          matchedTerms: match.matchedTerms,
          evidence: match.evidence,
        }
      }),
      note: 'Results are local evidence matches, not a claim that every asset is semantically understood. Analyze an unanalysed candidate with video_understand before a content-dependent placement.',
    }
  },

  video_search_visual_segments: async (args) => {
    const projectId = String(args.project_id || '')
    const query = String(args.query || '').trim()
    if (!projectId || !query) throw new Error('project_id and query are required')
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()

    const { buildVisualSegments, rankVisualSegments } = await import('@/perception')
    const { getCaptionImageEmbeddings } = await import('@/infrastructure/storage')
    const { clipProvider } = await import('@/infrastructure/analysis/embeddings/clip-provider')

    const targetMediaIds = Array.isArray(args.media_ids) && args.media_ids.length > 0
      ? new Set(args.media_ids.map(String))
      : null

    const candidateMedia = mediaStore.mediaItems.filter((m) => !targetMediaIds || targetMediaIds.has(m.id))

    // Attempt to compute CLIP text embedding for query
    let queryVector: Float32Array | undefined
    try {
      await clipProvider.ensureReady()
      const textEmbeddings = await clipProvider.embedTextForImages([query])
      if (textEmbeddings.length > 0) {
        queryVector = textEmbeddings[0]
      }
    } catch {
      queryVector = undefined
    }

    const segmentsWithVectors: Array<{ segment: any; imageVector?: Float32Array | number[] }> = []

    for (const media of candidateMedia) {
      const captions = media.aiCaptions ?? []
      const segments = buildVisualSegments({
        mediaId: media.id,
        durationSec: media.duration,
        fps: media.fps,
        contentHash: media.contentHash,
        captions,
      })

      let imageVectors: Float32Array[] | undefined
      if (captions.length > 0 && queryVector) {
        try {
          imageVectors = await getCaptionImageEmbeddings(media.id, { contentHash: media.contentHash })
        } catch {
          imageVectors = undefined
        }
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!
        const imageVector = imageVectors && imageVectors[i] ? imageVectors[i] : undefined
        segmentsWithVectors.push({ segment: seg, imageVector })
      }
    }

    const matches = rankVisualSegments({
      query,
      queryVector,
      segmentsWithVectors,
      minUsableDurationSec: typeof args.min_usable_duration_sec === 'number' ? args.min_usable_duration_sec : undefined,
      limit: typeof args.limit === 'number' ? args.limit : 10,
    })

    return {
      success: true,
      projectId,
      query,
      searchMode: queryVector ? 'clip_multimodal_segment' : 'keyword_segment_fallback',
      totalCandidatesEvaluated: segmentsWithVectors.length,
      resultCount: matches.length,
      results: matches.map((m) => ({
        mediaId: m.mediaId,
        segmentId: m.segment.id,
        startSec: m.startSec,
        endSec: m.endSec,
        durationSec: m.durationSec,
        semanticScore: m.semanticScore,
        vectorSimilarity: m.vectorSimilarity,
        description: m.segment.description,
        shotType: m.segment.sceneData?.shotType,
        action: m.segment.sceneData?.action,
        setting: m.segment.sceneData?.setting,
        subjects: m.segment.sceneData?.subjects,
        cameraMotion: m.segment.cameraMotion,
        motionLevel: m.segment.motionLevel,
        quality: m.segment.quality,
        thumbnailRelPath: m.segment.thumbnailRelPath,
        provenance: m.provenance,
      })),
      note: 'Results are time-indexed sub-clip visual segments. If top semanticScore is low or candidate distribution indicates no confident match, ask the user to import footage.',
    }
  },

  video_inspect_media: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')

    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) {
      mediaStore.setCurrentProject(projectId)
    }
    await useMediaLibraryStore.getState().loadMediaItems()

    const media = useMediaLibraryStore.getState().mediaById[mediaId]
    if (!media) throw new Error(`Media not found in project: ${mediaId}`)

    const timelineItems = useTimelineStore.getState().items
    const placements = timelineItems.filter((ti) => ti.mediaId === media.id || ti.assetId === media.id)
    const { getSemanticMediaMap } = await import('@/infrastructure/storage')
    const { buildAssetFingerprint } = await import('@/perception')
    const semanticMap = await getSemanticMediaMap(mediaId)
    const sourceAssetFingerprint = buildAssetFingerprint({
      mediaId: media.id,
      contentHash: media.contentHash,
      fileSize: media.fileSize,
      fileLastModified: media.fileLastModified,
      mimeType: media.mimeType,
    })
    const semanticMapCurrent = semanticMap?.sourceAnchor.assetFingerprint === sourceAssetFingerprint

    return {
      projectId,
      asset: {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        duration: media.duration,
        width: media.width,
        height: media.height,
        fps: media.fps,
        storageType: media.storageType,
      },
      timeline: {
        isOnTimeline: placements.length > 0,
        placementCount: placements.length,
        placements: placements.map((ti) => ({
          itemId: ti.id,
          trackId: ti.trackId,
          fromFrame: ti.from,
          durationFrames: ti.durationInFrames,
          sourceStart: ti.sourceStart,
          sourceEnd: ti.sourceEnd,
          label: ti.label,
        })),
      },
      analysis: {
        status: media.aiCaptions?.length ? 'analyzed' : 'not_analyzed',
        sceneCount: media.aiCaptions?.length || 0,
        semanticMap: semanticMap
          ? semanticMapCurrent
            ? {
              status: semanticMap.grounding.overall,
              transcriptSegments: semanticMap.grounding.transcript.segmentCount,
              visualMoments: semanticMap.grounding.visual.momentCount,
              reviewCandidates: semanticMap.reviewCandidates.length,
            }
            : { status: 'stale', reason: 'SOURCE_ASSET_FINGERPRINT_CHANGED' }
          : { status: 'not_built' },
      },
    }
  },

  // Resolve compact UI references such as @sclip/item/1a2b3c4d. The visible
  // editor remains the source of truth; the short clipboard token is only a
  // convenient handle, never a second project model.
  video_resolve_reference: async (args) => {
    const reference = String(args.reference || '').trim()
    const match = /^@sclip\/(item|media|transition)\/([0-9a-f-]{4,36})$/i.exec(reference)
    if (!match) {
      throw new Error('Invalid SCLIP reference. Copy it again from the SCLIP context menu.')
    }
    const [, kind, idPrefix] = match
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id : undefined

    const project = requestedProjectId
      ? await prepareProjectForAgent(requestedProjectId)
      : useProjectStore.getState().currentProject
    if (!project) throw new Error('No project is open to resolve the SCLIP reference')
    const projectId = project.id
    const findUnique = <T extends { id: string }>(values: T[], label: string): T => {
      const matches = values.filter((value) => value.id.toLowerCase().startsWith(idPrefix.toLowerCase()))
      if (matches.length === 1) return matches[0]
      if (matches.length === 0) throw new Error(`No ${label} matches ${reference} in project ${projectId}`)
      throw new Error(`Reference ${reference} is ambiguous; copy it again from SCLIP.`)
    }

    if (kind === 'media') {
      const mediaStore = useMediaLibraryStore.getState()
      if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
      await useMediaLibraryStore.getState().loadMediaItems()
      const media = findUnique(useMediaLibraryStore.getState().mediaItems, 'media item')
      const timelineItems = useTimelineStore.getState().items
      const placements = timelineItems.filter((ti) => ti.mediaId === media.id || ti.assetId === media.id)
      return {
        kind: 'media',
        projectId,
        media: {
          id: media.id,
          fileName: media.fileName,
          mimeType: media.mimeType,
          duration: media.duration,
          width: media.width,
          height: media.height,
          fps: media.fps,
          isOnTimeline: placements.length > 0,
          placementCount: placements.length,
          placements: placements.map((ti) => ({
            itemId: ti.id,
            trackId: ti.trackId,
            fromFrame: ti.from,
            durationFrames: ti.durationInFrames,
          })),
        },
      }
    }

    if (kind === 'transition') {
      const transition = findUnique(useTimelineStore.getState().transitions, 'transition')
      return { kind: 'transition', projectId, transition }
    }

    const item = findUnique(useTimelineStore.getState().items, 'timeline item')
    return {
      kind: 'timeline_item',
      projectId,
      item: {
        id: item.id,
        trackId: item.trackId,
        type: item.type,
        label: item.label,
        fromFrame: item.from,
        durationFrames: item.durationInFrames,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        ...(item.type === 'text' ? { text: item.text } : {}),
        ...(item.effects?.length
          ? { effects: item.effects.map((effect) => ({ id: effect.id, type: effect.effect.gpuEffectType })) }
          : {}),
      },
    }
  },

  video_list_projects: async (_args) => {
    await ensureSclipWorkspaceForAgent()
    const state = useProjectStore.getState()
    // Ensure projects are loaded from storage first.
    await state.loadProjects()
    const projectState = useProjectStore.getState()
    const activeProjectId = projectState.currentProject?.id ?? null
    const projects = projectState.projects.map((project) => ({
      ...project,
      // “Current” must come from the open editor, never an inferred
      // updatedAt sort. This is especially important when several projects
      // are open in the workspace.
      isOpenInEditor: project.id === activeProjectId,
    }))
    return { activeProjectId, projects }
  },

  video_transcribe: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')
    if (args.caption_mode === 'items' || args.caption_mode === 'virtual') {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_transcribe.captions')
    } else {
      await prepareProjectForAgent(projectId)
    }
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    if (!useMediaLibraryStore.getState().mediaById[mediaId]) {
      throw new Error(`Media not found in this project: ${mediaId}`)
    }
    const { runMediaTranscriptionJob } = await import(
      '@/features/media-library/services/media-transcription-runner'
    )
    const result = await runMediaTranscriptionJob(mediaId, { language: args.language || undefined })
    if (result.status === 'cancelled') return { success: false, status: 'cancelled', mediaId }

    let captions: unknown
    if (args.caption_mode === 'items' || args.caption_mode === 'virtual') {
      const { mediaTranscriptionService } = await import(
        '@/features/media-library/services/media-transcription-service'
      )
      captions = args.caption_mode === 'items'
        ? await mediaTranscriptionService.insertTranscriptAsCaptions(mediaId, { replaceExisting: true })
        : await mediaTranscriptionService.enableTranscriptCaptions(mediaId, { replaceExisting: true })
      await saveTimelineMutation(projectId)
    }
    return {
      success: true,
      status: 'completed',
      mediaId,
      segmentCount: result.transcript.segments.length,
      transcriptAvailable: true,
      nextStep: 'Call video_get_transcript for timestamped speech before proposing semantic cuts.',
      ...(captions ? { captions } : {}),
    }
  },

  // Speech evidence is intentionally paged: returning an entire long-form
  // transcript would bury the agent in unbounded output. Word timings are
  // preserved when FreeCut produced them so silence/filler tools can use the
  // exact source ranges rather than guessed cut points.
  video_get_transcript: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    if (!useMediaLibraryStore.getState().mediaById[mediaId]) {
      throw new Error(`Media not found in this project: ${mediaId}`)
    }

    const [{ getTranscript }, { getTranscriptReliability }] = await Promise.all([
      import('@/infrastructure/storage'),
      import('@/features/media-library/transcription/transcript-reliability'),
    ])
    const transcript = await getTranscript(mediaId)
    if (!transcript) {
      throw new Error('No transcript found for this media item. Call video_transcribe first.')
    }

    const startSec = Number.isFinite(args.start_sec) ? Math.max(0, Number(args.start_sec)) : 0
    const requestedEnd = Number.isFinite(args.end_sec) ? Math.max(startSec, Number(args.end_sec)) : Number.POSITIVE_INFINITY
    const maxSegments = Number.isFinite(args.max_segments)
      ? Math.max(1, Math.min(300, Math.floor(Number(args.max_segments))))
      : 120
    const reliability = getTranscriptReliability(transcript, useMediaLibraryStore.getState().mediaById[mediaId]?.duration)
    const matchingSegments = (reliability.transcriptReliable ? transcript.segments : []).filter(
      (segment) => segment.end > startSec && segment.start < requestedEnd,
    )
    const segments = matchingSegments.slice(0, maxSegments).map((segment) => ({
      startSec: Number(segment.start.toFixed(3)),
      endSec: Number(segment.end.toFixed(3)),
      text: segment.text,
      ...(segment.words?.length
        ? {
            words: segment.words.map((word) => ({
              text: word.text,
              startSec: Number(word.start.toFixed(3)),
              endSec: Number(word.end.toFixed(3)),
            ...(typeof word.confidence === 'number' ? { confidence: word.confidence } : {}),
            ...(word.speaker ? { speaker: word.speaker } : {}),
            })),
          }
        : {}),
    }))
    const lastSegment = segments.at(-1)

    return {
      success: true,
      mediaId,
      model: transcript.model,
      language: transcript.language,
      speechDetected: reliability.speechDetected,
      speechConfidence: reliability.speechConfidence,
      speechCoverage: reliability.speechCoverage,
      transcriptReliable: reliability.transcriptReliable,
      reliabilityScore: reliability.reliabilityScore,
      reliabilityReasons: reliability.reliabilityReasons,
      rawAsrRetainedForDiagnostics: !reliability.transcriptReliable,
      totalSegments: transcript.segments.length,
      returnedSegments: segments.length,
      startSec,
      endSec: lastSegment?.endSec ?? startSec,
      hasMore: matchingSegments.length > segments.length,
      ...(lastSegment && matchingSegments.length > segments.length
        ? { nextStartSec: lastSegment.endSec }
        : {}),
      segments,
    }
  },

  // The canonical speech-editing surface. wordId identifies source evidence;
  // itemId identifies a concrete placement of it on the editor timeline.
  video_read_script: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = typeof args.media_id === 'string' && args.media_id ? args.media_id : undefined
    if (!projectId) throw new Error('project_id is required')
    const { project, timeline, tokens, scriptRevision, transcriptReliability } = await loadProjectScript(projectId, mediaId)
    const startFrame = Number.isFinite(args.start_frame) ? Math.max(0, Math.floor(args.start_frame)) : 0
    const endFrame = Number.isFinite(args.end_frame) ? Math.max(startFrame, Math.floor(args.end_frame)) : Number.POSITIVE_INFINITY
    const maxWords = Number.isFinite(args.max_words) ? Math.max(1, Math.min(1000, Math.floor(args.max_words))) : 300
    const matching = tokens.filter((token) => token.endFrame > startFrame && token.startFrame < endFrame)
    const words = matching.slice(0, maxWords).map((token) => scriptWord(token, timeline.fps))
    const lastWord = words.at(-1)
    return {
      success: true,
      projectId,
      ...(mediaId ? { mediaId } : {}),
      fps: timeline.fps,
      projectRevision: getLiveProjectRevision(project),
      scriptRevision,
      totalWords: matching.length,
      returnedWords: words.length,
      hasMore: matching.length > words.length,
      ...(lastWord && matching.length > words.length ? { nextStartFrame: lastWord.timelineEndFrame } : {}),
      words,
      text: words.map((word) => word.text).join(' '),
      transcriptReliability: Object.values(transcriptReliability),
      note: 'wordId is stable for the source transcript. Pair it with itemId when requesting an edit.',
    }
  },

  video_find_speech: async (args) => {
    const projectId = String(args.project_id || '')
    const query = typeof args.query === 'string' ? normaliseScriptText(args.query) : ''
    const kind = String(args.kind || (query ? 'phrase' : '')).toLowerCase()
    const mediaId = typeof args.media_id === 'string' && args.media_id ? args.media_id : undefined
    if (!projectId || !['phrase', 'filler'].includes(kind)) {
      throw new Error('project_id and either query (for phrase) or kind="filler" are required')
    }
    if (kind === 'phrase' && !query) throw new Error('query is required when kind is phrase')
    const { project, timeline, tokens, scriptRevision } = await loadProjectScript(projectId, mediaId)
    const matches: Array<{ type: 'phrase' | 'filler'; word: ReturnType<typeof scriptWord>; evidence: string }> = []
    for (let index = 0; index < tokens.length && matches.length < 100; index += 1) {
      const token = tokens[index]
      if (!token) continue
      if (kind === 'filler') {
        if (!SCRIPT_FILLER_PATTERN.test(token.text.trim())) continue
        matches.push({ type: 'filler', word: scriptWord(token, timeline.fps), evidence: `Fixed hesitation word “${token.text}”.` })
        continue
      }
      const window = tokens.slice(index, index + 16)
      const windowText = normaliseScriptText(window.map((candidate) => candidate.text).join(' '))
      if (!windowText.includes(query)) continue
      matches.push({ type: 'phrase', word: scriptWord(token, timeline.fps), evidence: `Matches “${args.query.trim()}”.` })
    }
    return { success: true, projectId, projectRevision: getLiveProjectRevision(project), scriptRevision, kind, query: args.query, matches }
  },

  // A narrow first apply_script: it resolves stable word refs to their real
  // timeline placement, previews ranges, then reuses FreeCut's established
  // split/remove/ripple command. Every confirmed result remains undoable.
  video_apply_script: async (args) => {
    const projectId = String(args.project_id || '')
    const operations = Array.isArray(args.operations) ? args.operations : []
    if (!projectId || operations.length === 0) throw new Error('project_id and one or more operations are required')
    if (args.confirm === true) {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_apply_script')
    }
    const { project, timeline, tokens, scriptRevision } = await loadProjectScript(projectId)
    const projectRevision = getLiveProjectRevision(project)
    const preview = await previewScriptRemovalOperations(operations, tokens, timeline.fps)
    if (args.confirm !== true) {
      return {
        success: true,
        applied: false,
        projectRevision,
        scriptRevision,
        preview,
        nextStep: 'Review the exact source/timeline ranges, then call video_apply_script again with confirm: true, expected_revision set to projectRevision, and expected_script_revision set to scriptRevision to create undoable timeline edits.',
      }
    }
    const expectedScriptRevision = String(args.expected_script_revision ?? args.expectedScriptRevision ?? '')
    if (!expectedScriptRevision) {
      throw new Error('expected_script_revision from the script preview is required when confirm=true')
    }
    if (expectedScriptRevision !== scriptRevision) {
      throw staleScriptRevisionError(expectedScriptRevision, scriptRevision)
    }
    const results = preview.map((entry) => ({
      operationIndex: entry.operationIndex,
      itemId: entry.itemId,
      result: timeline.removeTranscriptRangesFromItems([entry.itemId], entry.rangesByMediaId),
    }))
    await saveTimelineMutation(projectId)
    return {
      success: true,
      applied: true,
      previousProjectRevision: projectRevision,
      previousScriptRevision: scriptRevision,
      scriptRevision: await buildScriptTimelineRevision({ fps: timeline.fps, items: useTimelineStore.getState().items }),
      results,
      undo: 'Use video_history with action="undo" to revert these edits.',
    }
  },

  // A rough cut is an explicit, durable plan—not a hidden LLM side effect.
  // The only currently executable operation is remove_words, because it maps
  // exactly to FreeCut's established split/remove/ripple history action.
  video_rough_cut_proposal: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || 'list')
    if (!projectId || !['save', 'list', 'get', 'preview_apply', 'apply'].includes(action)) {
      throw new Error('project_id and action (save, list, get, preview_apply, or apply) are required')
    }
    if (action === 'apply' && args.confirm === true) {
      await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_rough_cut_proposal.apply')
    } else {
      await prepareProjectForAgent(projectId)
    }
    if (action === 'list') return invoke('sclip_rough_cut_proposal', { action: 'list', projectId })

    const proposalId = String(args.proposal_id || args.proposalId || '')
    if (action === 'get') {
      if (!proposalId) throw new Error('proposal_id is required to get a rough-cut proposal')
      return invoke('sclip_rough_cut_proposal', { action: 'get', projectId, proposalId })
    }

    const { project, timeline, tokens, scriptRevision } = await loadProjectScript(projectId)
    const projectRevision = getLiveProjectRevision(project)
    if (action === 'save') {
      const proposal = normaliseRoughCutProposal(args.proposal, scriptRevision)
      const preview = await previewScriptRemovalOperations(proposal.operations, tokens, timeline.fps)
      const saved = await invoke<{ proposal: { id: string; createdAt: number; data: unknown } }>('sclip_rough_cut_proposal', {
        action: 'save', projectId, proposal,
      })
      return {
        success: true,
        applied: false,
        proposalId: saved.proposal.id,
        createdAt: saved.proposal.createdAt,
        projectRevision,
        proposal,
        preview,
        nextStep: 'Present this proposal clearly to the user. Call video_rough_cut_proposal with action="preview_apply" before applying, then action="apply", confirm=true, expected_revision=projectRevision, and expected_script_revision=scriptRevision from that preview.',
      }
    }

    if (!proposalId) throw new Error('proposal_id is required to preview or apply a rough-cut proposal')
    const saved = await invoke<{ proposal: unknown }>('sclip_rough_cut_proposal', { action: 'get', projectId, proposalId })
    const proposal = normaliseRoughCutProposal(saved.proposal, scriptRevision)
    const preview = await previewScriptRemovalOperations(proposal.operations, tokens, timeline.fps)
    if (action === 'preview_apply') {
      return {
        success: true,
        applied: false,
        proposalId,
        proposal,
        projectRevision,
        scriptRevision,
        preview,
        nextStep: 'Review the exact ranges and proposed removals with the user. Apply only after explicit confirmation using expected_revision=projectRevision and expected_script_revision=scriptRevision from this response.',
      }
    }

    if (args.confirm !== true) throw new Error('confirm=true is required to apply a rough-cut proposal')
    const expectedScriptRevision = String(args.expected_script_revision ?? args.expectedScriptRevision ?? '')
    if (!expectedScriptRevision) throw new Error('expected_script_revision from preview_apply is required to apply a rough-cut proposal')
    if (expectedScriptRevision !== scriptRevision) throw staleScriptRevisionError(expectedScriptRevision, scriptRevision)

    // Save the exact current editor state first. If anything looks wrong the
    // user can restore this named point, and the same edit is also undoable.
    const { getProject } = await import('@/infrastructure/storage')
    const snapshotProject = await getProject(projectId)
    if (!snapshotProject) throw new Error(`Project not found: ${projectId}`)
    const snapshot = await invoke<{ snapshot: { id: string; label: string } }>('sclip_project_snapshot', {
      action: 'create', projectId, label: `Before rough-cut proposal: ${proposal.summary.slice(0, 72)}`, project: snapshotProject,
    })
    const results = preview.map((entry) => ({
      operationIndex: entry.operationIndex,
      itemId: entry.itemId,
      result: timeline.removeTranscriptRangesFromItems([entry.itemId], entry.rangesByMediaId),
    }))
    await saveTimelineMutation(projectId)
    return {
      success: true,
      applied: true,
      proposalId,
      proposalSummary: proposal.summary,
      previousProjectRevision: projectRevision,
      previousScriptRevision: scriptRevision,
      scriptRevision: await buildScriptTimelineRevision({ fps: timeline.fps, items: useTimelineStore.getState().items }),
      snapshot: snapshot.snapshot,
      results,
      undo: 'Use video_history with action="undo" to revert this edit, or video_project_snapshot to restore the named recovery point.',
    }
  },

  video_get_editorial_evidence: async (args) => {
    const projectId = String(args.project_id || '')
    const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
    if (!projectId || !objective) throw new Error('project_id and objective are required')
    return buildEditorialEvidenceBundle(projectId, objective)
  },

  video_get_editing_guidance: async (args) => {
    const { getEditingGuidance } = await import('@/features/editor/agent/editing-guidance')
    const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    return getEditingGuidance({
      topics: Array.isArray(raw.topics) ? raw.topics : typeof raw.topic === 'string' ? [raw.topic] : undefined,
      contentTypes: Array.isArray(raw.content_types) ? raw.content_types : Array.isArray(raw.contentTypes) ? raw.contentTypes : undefined,
      segmentGenres: Array.isArray(raw.segment_genres) ? raw.segment_genres : Array.isArray(raw.segmentGenres) ? raw.segmentGenres : undefined,
      projectIntent: typeof raw.project_intent === 'string' ? raw.project_intent : typeof raw.projectIntent === 'string' ? raw.projectIntent : undefined,
    })
  },

  // Hermes is SCLIP's one general planner. This handler validates, previews,
  // and orchestrates only the small allowlisted executor registry below.
  video_edit_plan: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || 'list')
    if (!projectId || !['save', 'list', 'get', 'validate', 'preview', 'execute'].includes(action)) {
      throw new Error('project_id and action (save, list, get, validate, preview, or execute) are required')
    }
    const project = await prepareProjectForAgent(projectId)
    if (action === 'list') return invoke('sclip_edit_plan', { action: 'list', projectId })
    const planId = String(args.plan_id || args.planId || '')
    if (action === 'get') {
      if (!planId) throw new Error('plan_id is required to get an edit plan')
      return invoke('sclip_edit_plan', { action: 'get', projectId, planId })
    }
    const { normaliseEditPlan, EDIT_PLAN_EXECUTORS, validateEditPlanForV1 } = await import('@/features/editor/agent/edit-plan')
    const projectRevision = getLiveProjectRevision(project)
    const persisted = action === 'save' ? undefined : await invoke<{ plan: unknown }>('sclip_edit_plan', { action: 'get', projectId, planId: planId || undefined })
    const plan = normaliseEditPlan(action === 'save' ? args.plan : persisted?.plan, { projectId, projectRevision })
    const bundle = await buildEditorialEvidenceBundle(projectId, plan.goal)
    const knownEvidence = new Set<string>([
      ...bundle.evidenceRefs.map((reference) => reference.id),
      ...bundle.heuristicCandidates.map((candidate) => String(candidate.evidenceId)),
    ])
    const validationErrors = validateEditPlanForV1(plan, knownEvidence)
    const validation = { valid: validationErrors.length === 0, projectId, projectRevision, planId: planId || undefined, errors: validationErrors, executorRegistry: EDIT_PLAN_EXECUTORS }
    if (action === 'validate') return validation
    if (!validation.valid) throw new Error(JSON.stringify({ code: 'EDIT_PLAN_VALIDATION_FAILED', ...validation }))
    if (action === 'save') {
      const saved = await invoke<{ plan: { id: string; createdAt: number; data: unknown } }>('sclip_edit_plan', {
        action: 'save', projectId, plan,
      })
      return {
        success: true, applied: false, planId: saved.plan.id, createdAt: saved.plan.createdAt, plan, validation,
        nextStep: 'Use action="preview" for a deterministic diff before action="execute". Execution still requires confirm=true and the live expected_revision.',
      }
    }
    const previews: Array<{ operationId: string; preview: unknown }> = []
    for (const operation of plan.operations) {
      if (operation.executor === 'video_apply_script') {
        const preview = await approvedToolHandler('video_apply_script')({ project_id: projectId, operations: operation.args.operations, confirm: false })
        previews.push({ operationId: operation.id, preview })
      } else if (operation.executor === 'video_add_clip') {
        previews.push({
          operationId: operation.id,
          preview: {
            type: 'add_clip',
            mediaId: operation.args.media_id,
            trackId: operation.args.track_id,
            fromFrame: operation.args.from_frame,
            durationFrames: operation.args.duration_frames,
            sourceStartFrame: operation.args.source_start_frame,
          },
        })
      } else if (operation.executor === 'video_add_track') {
        previews.push({ operationId: operation.id, preview: { type: 'add_track', kind: operation.args.kind } })
      } else if (operation.executor === 'video_update_transform') {
        previews.push({ operationId: operation.id, preview: { type: 'transform_mutation', itemId: operation.args.item_id, transform: operation.args.transform } })
      } else {
        previews.push({ operationId: operation.id, preview: { type: 'primitive_mutation', itemId: operation.args.item_id, updates: operation.args.updates } })
      }
    }
    const preview = planPreviewFromOperations(plan, previews)
    if (action === 'preview') return { success: true, applied: false, ...preview, validation }
    if (args.confirm !== true) throw new Error('confirm=true is required to execute an edit plan after preview')
    // Execution uses the normal revision guard and a named recovery point;
    // individual executors keep their own argument and script-placement checks.
    await prepareTimelineMutation(projectId, undefined, args.expected_revision, 'video_edit_plan.execute')
    const { getProject } = await import('@/infrastructure/storage')
    const snapshotProject = await getProject(projectId)
    if (!snapshotProject) throw new Error(`Project not found: ${projectId}`)
    const snapshot = await invoke<{ snapshot: { id: string; label: string } }>('sclip_project_snapshot', { action: 'create', projectId, label: `Before EditPlan: ${plan.title.slice(0, 72)}`, project: snapshotProject })
    const results: Array<{ operationId: string; status: 'executed' | 'skipped' | 'failed'; proposedArgs: Record<string, unknown>; evidenceIds: string[]; result?: unknown; error?: string }> = []
    const completed = new Set<string>()
    let failed = false
    for (const operation of plan.operations) {
      if (failed || (operation.dependsOn ?? []).some((dependency) => !completed.has(dependency))) {
        results.push({ operationId: operation.id, status: 'skipped', proposedArgs: operation.args, evidenceIds: operation.evidenceIds, error: 'A prerequisite operation did not complete.' })
        continue
      }
      try {
        let result: unknown
        const transformItemBefore = operation.executor === 'video_update_transform'
          ? useTimelineStore.getState().items.find((item) => item.id === operation.args.item_id)
          : undefined
        const baselineWidth = Number((transformItemBefore as unknown as { transform?: { width?: number } } | undefined)?.transform?.width)
        if (operation.executor === 'video_apply_script') {
          const scriptPreview = await approvedToolHandler('video_apply_script')({ project_id: projectId, operations: operation.args.operations, confirm: false }) as { projectRevision: string; scriptRevision: string }
          result = await approvedToolHandler('video_apply_script')({ project_id: projectId, operations: operation.args.operations, confirm: true, expected_revision: scriptPreview.projectRevision, expected_script_revision: scriptPreview.scriptRevision })
        } else if (operation.executor === 'video_add_clip') {
          result = await approvedToolHandler('video_add_clip')({ project_id: projectId, ...operation.args, expected_revision: getLiveProjectRevision(await prepareProjectForAgent(projectId)) })
        } else if (operation.executor === 'video_add_track') {
          result = await approvedToolHandler('video_add_track')({ project_id: projectId, ...operation.args, expected_revision: getLiveProjectRevision(await prepareProjectForAgent(projectId)) })
        } else if (operation.executor === 'video_update_transform') {
          result = await approvedToolHandler('video_update_transform')({ project_id: projectId, item_id: operation.args.item_id, transform: operation.args.transform, expected_revision: getLiveProjectRevision(await prepareProjectForAgent(projectId)) })
        } else {
          result = await approvedToolHandler('video_update_item')({ project_id: projectId, item_id: operation.args.item_id, updates: operation.args.updates, expected_revision: getLiveProjectRevision(await prepareProjectForAgent(projectId)) })
        }
        results.push({ operationId: operation.id, status: 'executed', proposedArgs: operation.args, evidenceIds: operation.evidenceIds, result })
        if (operation.executor === 'video_update_transform') {
          const transformedItem = useTimelineStore.getState().items.find((item) => item.id === operation.args.item_id)
          const proposedWidth = Number((transformedItem as unknown as { transform?: { width?: number } } | undefined)?.transform?.width)
          registerAiTransformAttribution({
            projectId,
            planId,
            operationId: operation.id,
            itemId: String(operation.args.item_id),
            baselineWidth,
            proposedWidth,
          })
        }
        completed.add(operation.id)
      } catch (error) {
        failed = true
        results.push({ operationId: operation.id, status: 'failed', proposedArgs: operation.args, evidenceIds: operation.evidenceIds, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const deterministic = await approvedToolHandler('video_validate_project')({ project_id: projectId, mode: 'render' })
    const needsPerceptualVerification = plan.operations.some((operation) => operation.verification.includes('perceptual'))
    const duration = useTimelineStore.getState().items.reduce((end, item) => Math.max(end, item.from + item.durationInFrames), 0)
    const perceptual = needsPerceptualVerification
      ? await approvedToolHandler('video_review_preview')({ project_id: projectId, frames: [0, Math.max(0, Math.floor(duration / 2)), Math.max(0, duration - 1)] })
        .then((review) => {
        // The compositor is the authority for perceptual verification. A
        // completed request is not a verified edit: partial and degraded
        // reviews must remain explicitly degraded for the caller.
        const status = review?.visualVerification?.status ?? review?.status
        const passed = status === 'verified'
        return { passed, observations: review, degraded: !passed, status }
        })
        .catch((error) => ({ passed: false, observations: [], degraded: true, limitation: error instanceof Error ? error.message : String(error) }))
      : { passed: false, observations: [], degraded: false, status: 'not_requested' }
    return {
      success: !failed, applied: !failed, planId, snapshot: snapshot.snapshot, results,
      rollback: failed ? { attempted: false, availableSnapshotId: snapshot.snapshot.id, reason: 'Execution stopped. The named snapshot is available for explicit restore; no unsafe automatic timeline rollback was attempted.' } : { attempted: false },
      verification: { planId, projectRevisionBefore: projectRevision, projectRevisionAfter: getLiveProjectRevision(await prepareProjectForAgent(projectId)), deterministic, perceptual, editorialInputs: { originalGoal: plan.goal, planSummary: plan.title, relevantGuidanceIds: [] } },
    }
  },

  video_correction_event: async (args) => {
    const projectId = String(args.project_id || '')
    const action = String(args.action || 'list')
    if (!projectId || !['record', 'list', 'reset_project'].includes(action)) {
      throw new Error('project_id and action (record, list, or reset_project) are required')
    }
    await prepareProjectForAgent(projectId)
    if (action === 'list') {
      const archive = await invoke<{ events?: Array<{ correction?: unknown }> }>('sclip_correction_event', { action: 'list', projectId })
      const { reconstructStyleProfileFromEvents, getCreatorStyleContext } = await import('@/perception')
      const events = (archive.events ?? []).flatMap((entry) => entry.correction && typeof entry.correction === 'object' ? [entry.correction] : [])
      const styleProfile = reconstructStyleProfileFromEvents(events as never[], 'local_creator')
      return { ...archive, styleProfile, relevantStyle: getCreatorStyleContext(styleProfile, { projectId, contentType: 'general' }) }
    }
    if (action === 'reset_project') {
      const result = await invoke('sclip_correction_event', { action: 'reset_project', projectId })
      clearPendingAttributionsForProject(projectId)
      return result
    }
    if (!args.correction || typeof args.correction !== 'object') {
      throw new Error('correction must be a structured object; do not store credentials or raw chat transcripts')
    }
    return invoke('sclip_correction_event', {
      action: 'record', projectId,
      planId: typeof args.plan_id === 'string' ? args.plan_id : undefined,
      operationId: typeof args.operation_id === 'string' ? args.operation_id : undefined,
      outcome: typeof args.outcome === 'string' ? args.outcome : undefined,
      correction: args.correction,
    })
  },

  // Join the evidence FreeCut already owns into a durable map for Hermes.
  // This is deliberately read/analysis-only: candidates identify material for
  // review but never make a cut until the agent creates a separate edit plan.
  video_build_semantic_map: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()
    const media = useMediaLibraryStore.getState().mediaById[mediaId]
    if (!media) throw new Error(`Media not found in this project: ${mediaId}`)

    const [{ getTranscript, saveSemanticMediaMap }, { buildSemanticMediaMap, buildAssetFingerprint }, { getTranscriptReliability }] = await Promise.all([
      import('@/infrastructure/storage'),
      import('@/perception'),
      import('@/features/media-library/transcription/transcript-reliability'),
    ])
    const transcript = await getTranscript(mediaId)
    const reliability = transcript ? getTranscriptReliability(transcript, media.duration) : undefined
    const map = buildSemanticMediaMap({
      mediaId,
      assetFingerprint: buildAssetFingerprint({
        mediaId,
        contentHash: media.contentHash,
        fileSize: media.fileSize,
        fileLastModified: media.fileLastModified,
        mimeType: media.mimeType,
      }),
      durationSec: media.duration,
      transcriptSegments: reliability?.transcriptReliable ? transcript?.segments.map((segment) => ({
        text: segment.text,
        startSec: segment.start,
        endSec: segment.end,
        words: segment.words?.map((word) => ({
          id: buildTranscriptWordId(mediaId, word),
          text: word.text,
          startSec: word.start,
          endSec: word.end,
          confidence: word.confidence,
          speaker: word.speaker ?? segment.speaker,
        })),
      })) : undefined,
      visualMoments: media.aiCaptions?.map((caption) => ({
        timeSec: caption.timeSec,
        text: caption.text,
        scene: caption.sceneData
          ? {
              shotType: caption.sceneData.shotType,
              subjects: caption.sceneData.subjects,
              action: caption.sceneData.action,
              setting: caption.sceneData.setting,
            }
          : undefined,
      })),
    })
    const savedMap = await saveSemanticMediaMap(map)
    return {
      success: true,
      projectId,
      mediaId,
      map: savedMap,
      transcriptReliability: reliability,
      nextStep: savedMap.grounding.overall === 'grounded'
        ? 'Use this evidence to propose a review-first rough-cut plan; do not delete candidates automatically.'
        : savedMap.recommendedNextSteps,
    }
  },

  video_understand: async (args) => {
    const projectId = String(args.project_id || '')
    const mediaId = String(args.media_id || '')
    if (!projectId || !mediaId) throw new Error('project_id and media_id are required')
    await prepareProjectForAgent(projectId)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
    if (!useMediaLibraryStore.getState().mediaById[mediaId]) {
      throw new Error(`Media not found in this project: ${mediaId}`)
    }
    const { mediaAnalysisService } = await import(
      '@/features/media-library/services/media-analysis-service'
    )
    const success = await mediaAnalysisService.analyzeMedia(mediaId)
    if (!success) throw new Error(`FreeCut could not analyze media: ${mediaId}`)
    const media = useMediaLibraryStore.getState().mediaById[mediaId]
    const captions = (media?.aiCaptions ?? []).map((caption) => ({
      timeSec: caption.timeSec,
      text: caption.text,
      scene: caption.sceneData
        ? {
            shotType: caption.sceneData.shotType,
            subjects: caption.sceneData.subjects,
            action: caption.sceneData.action,
            setting: caption.sceneData.setting,
            lighting: caption.sceneData.lighting,
            timeOfDay: caption.sceneData.timeOfDay,
            weather: caption.sceneData.weather,
          }
        : undefined,
      // Captured by FreeCut's visual analysis pass, never fabricated by the
      // agent. A file/image-capable Hermes tool can inspect one if prose is
      // insufficient for a creative decision.
      thumbnailPath: caption.thumbRelPath,
      palette: caption.palette,
    }))
    const { buildAssetFingerprint } = await import('@/perception')
    const sourceAssetFingerprint = buildAssetFingerprint({
      mediaId,
      contentHash: media?.contentHash,
      fileSize: media?.fileSize,
      fileLastModified: media?.fileLastModified,
      mimeType: media?.mimeType,
    })
    const semanticVisionPerformed = captions.length > 0
    const provenance = {
      id: `source:${sourceAssetFingerprint}:sclip-media-analysis-v1`,
      scope: 'source' as const,
      pixelsCaptured: semanticVisionPerformed,
      pixelsAnalyzed: semanticVisionPerformed,
      semanticVisionPerformed,
      structuralStateInspected: false,
      audioAnalyzed: false,
      ocrPerformed: false,
      provider: semanticVisionPerformed ? 'freecut-local-vision-language-model' : 'none',
      model: semanticVisionPerformed ? 'configured-local-caption-model' : undefined,
      source: 'source_media_analysis' as const,
      sourceAssetFingerprint,
      analysisVersion: 'sclip-media-analysis-v1',
      confidence: semanticVisionPerformed ? 0.8 : 0,
      degraded: !semanticVisionPerformed,
      degradedReason: semanticVisionPerformed ? undefined : 'VISION_MODEL_NO_OBSERVATIONS',
    }
    const { buildVisualSegments } = await import('@/perception')
    const segments = buildVisualSegments({
      mediaId,
      durationSec: media?.duration || 0,
      fps: media?.fps,
      contentHash: media?.contentHash,
      captions: media?.aiCaptions,
    })

    return {
      success: true,
      mediaId,
      analyzedWith: semanticVisionPerformed ? 'SCLIP local vision-language scene analysis' : 'No visual observation was produced.',
      provenance,
      sourceEvidence: {
        id: provenance.id,
        scope: 'source',
        provider: provenance.provider,
        assetFingerprint: sourceAssetFingerprint,
        analysisVersion: provenance.analysisVersion,
        limitations: captions.length
          ? ['Observations are timestamped source-frame samples, not a claim that every frame was inspected.']
          : ['I could not visually inspect the pixels. The source analysis produced no visual samples; do not infer visual content from this result.'],
      },
      sceneCount: captions.length,
      segmentCount: segments.length,
      segments,
      captions,
    }
  },

  video_detect_scenes: async (args) => {
    const projectId = String(args.project_id || '')
    const itemId = String(args.item_id || '')
    if (!projectId || !itemId) throw new Error('project_id and item_id are required')
    let timeline: ReturnType<typeof useTimelineStore.getState>
    let item: ReturnType<typeof useTimelineStore.getState>['items'][number] | undefined
    if (args.split === true) {
      const guarded = await prepareTimelineMutation(projectId, itemId, args.expected_revision, 'video_detect_scenes.split')
      timeline = guarded.timeline
      item = guarded.item
    } else {
      await prepareProjectForAgent(projectId)
      timeline = useTimelineStore.getState()
      item = timeline.items.find((candidate) => candidate.id === itemId)
    }
    if (!item) throw new Error(`Timeline item not found: ${itemId}`)
    const typedItem = item as { id: string; type: string; mediaId?: string; from: number; durationInFrames: number; sourceStart?: number }
    if (typedItem.type !== 'video' || !typedItem.mediaId) throw new Error('Scene detection requires a media-backed video clip')
    const method = args.method === 'adaptive' ? 'adaptive' : 'histogram'
    const { resolveMediaUrl } = await import('@/features/timeline/deps/media-library-resolver')
    const { detectScenes, SCENE_DETECTOR_VERSION } = await import('@/features/timeline/deps/analysis')
    const { mapSceneCutTimesToTimelineFrames } = await import('@/features/timeline/utils/scene-cut-frames')
    const { saveScenes } = await import('@/infrastructure/storage/workspace-fs/scenes')
    const media = useMediaLibraryStore.getState().mediaById[typedItem.mediaId]
    const mediaFps = media?.fps || timeline.fps
    const video = document.createElement('video')
    video.src = await resolveMediaUrl(typedItem.mediaId)
    video.muted = true
    video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Failed to load video for scene detection'))
    })
    try {
      const cuts = await detectScenes(video, { method, mediaId: typedItem.mediaId, sourceFps: mediaFps })
      await saveScenes({
        mediaId: typedItem.mediaId,
        service: method === 'histogram' ? 'scene-detect-histogram' : 'scene-detect-adaptive',
        model: method,
        method,
        detectorVersion: SCENE_DETECTOR_VERSION,
        sampleIntervalMs: method === 'histogram' ? 250 : undefined,
        cuts,
      })
      const splitFrames = mapSceneCutTimesToTimelineFrames({
        cuts,
        sourceStartSeconds: (typedItem.sourceStart ?? 0) / mediaFps,
        projectFps: timeline.fps,
        clipFrom: typedItem.from,
        clipDurationInFrames: typedItem.durationInFrames,
      })
      const splitCount = args.split === true && splitFrames.length > 0
        ? timeline.splitItemAtFrames(typedItem.id, splitFrames)
        : 0
      if (splitCount > 0) await saveTimelineMutation(projectId)
      return { success: true, itemId, method, cuts, splitFrames, splitCount }
    } finally {
      video.removeAttribute('src')
      video.load()
    }
  },

  video_render_status: async (args) => {
    const { useRenderQueueStore } = await import('@/features/export/stores/render-queue-store')
    const queue = useRenderQueueStore.getState()
    const jobs = queue.jobs.filter((job) => !args.project_id || job.projectId === args.project_id)
    if (args.job_id) {
      const job = jobs.find((candidate) => candidate.id === args.job_id)
      if (!job) throw new Error(`Render job not found: ${args.job_id}`)
      if (args.action === 'cancel') queue.cancelJob(job.id)
      return { success: true, job: useRenderQueueStore.getState().jobs.find((candidate) => candidate.id === job.id) }
    }
    return { success: true, jobs }
  },

  // A deliberately read-only preflight. The agent must distinguish an
  // intentional overlay from two story clips accidentally competing on a
  // track; this reports facts and leaves the creative correction to Hermes.
  video_validate_project: async (args) => {
    const projectId = String(args.project_id || '')
    if (!projectId) throw new Error('project_id is required')
    const mode = args.mode === 'render' ? 'render' : 'preflight'
    const project = await prepareProjectForAgent(projectId)
    const inspection = buildLiveTimelineInspection(project)
    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== projectId) mediaStore.setCurrentProject(projectId)
    await mediaStore.loadMediaItems()
    const knownMedia = useMediaLibraryStore.getState().mediaById
    const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string; itemIds?: string[]; trackId?: string }> = []
    const mediaByTrack = new Map<string, typeof inspection.items>()
    for (const item of inspection.items) {
      if (item.mediaId && !knownMedia[item.mediaId]) {
        issues.push({ severity: 'error', code: 'missing_media', message: `${item.label || item.id} is no longer available in this project's media library.`, itemIds: [item.id] })
      }
      if (item.type === 'video' || item.type === 'audio') {
        const list = mediaByTrack.get(item.trackId) ?? []
        list.push(item)
        mediaByTrack.set(item.trackId, list)
      }
    }
    for (const [trackId, items] of mediaByTrack) {
      const ordered = items.slice().sort((a, b) => a.fromFrame - b.fromFrame)
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]
        const current = ordered[index]
        if (current.fromFrame < previous.endFrame) {
          issues.push({
            severity: 'warning', code: 'same_track_overlap', trackId,
            itemIds: [previous.id, current.id],
            message: `${previous.label || previous.id} and ${current.label || current.id} overlap on the same track. Confirm this is intentional before rendering.`,
          })
        }
      }
    }
    for (const track of inspection.tracks) {
      if (track.itemIds.length && track.locked) issues.push({ severity: 'warning', code: 'locked_track', trackId: track.id, message: `${track.name} contains items but is locked.` })
      if (track.itemIds.length && track.visible === false && track.kind !== 'audio') issues.push({ severity: 'warning', code: 'hidden_visual_track', trackId: track.id, message: `${track.name} contains visual items but is hidden.` })
      if (track.itemIds.length && track.muted && track.kind === 'audio') issues.push({ severity: 'warning', code: 'muted_audio_track', trackId: track.id, message: `${track.name} contains audio items but is muted.` })
    }
    if (!inspection.items.length) issues.push({ severity: 'error', code: 'empty_timeline', message: 'The project has no timeline items.' })
    if (mode === 'render' && inspection.durationInFrames === 0) issues.push({ severity: 'error', code: 'zero_duration', message: 'The project has no renderable duration.' })
    return {
      success: !issues.some((issue) => issue.severity === 'error'),
      mode, projectId, durationFrames: inspection.durationInFrames,
      checked: { itemCount: inspection.items.length, trackCount: inspection.tracks.length, mediaCount: Object.keys(knownMedia).length },
      issues,
      nextStep: issues.some((issue) => issue.severity === 'error') ? 'Fix errors and run validation again.' : mode === 'render' ? 'Safe to enqueue render; inspect warnings deliberately.' : 'Safe to continue; inspect warnings deliberately.',
    }
  },
}

let isInitialized = false
// Tauri can replay an event while a webview is remounting. Tool calls are not
// idempotent in general, so a duplicate must never execute a second time or
// report a false "No pending request" failure after the first response won.
const activeToolCallIds = new Set<string>()
const recentlyHandledToolCallIds = new Map<string, number>()
const RECENT_TOOL_CALL_TTL_MS = 2 * 60_000

export async function initMcpBridge(): Promise<UnlistenFn | undefined> {
  if (isInitialized) return
  isInitialized = true
  try {
    const unlisten = await listen('sclip-tool-call', async (event: any) => {
      const payload = typeof event?.payload === 'string' ? JSON.parse(event.payload) : event?.payload
      const { id, tool, args } = payload || {}
      if (typeof id !== 'string' || !id) return
      const now = Date.now()
      for (const [callId, completedAt] of recentlyHandledToolCallIds) {
        if (now - completedAt > RECENT_TOOL_CALL_TTL_MS) recentlyHandledToolCallIds.delete(callId)
      }
      if (activeToolCallIds.has(id) || recentlyHandledToolCallIds.has(id)) return
      activeToolCallIds.add(id)
      let projectId: string | undefined

      try {
        const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
        projectId = typeof parsedArgs?.project_id === 'string' ? parsedArgs.project_id : undefined
        // Local operational trace only: never write the prompt, tool arguments,
        // media contents, or credentials to the audit file.
        void invoke('sclip_agent_audit', { action: 'record', callId: id, tool, projectId, phase: 'started' })
        const handler = TOOL_HANDLERS[tool]
        if (!handler) {
          throw new Error(`Unknown tool: ${tool}`)
        }

        const result = await handler(parsedArgs)

        await invoke('handle_tool_result', {
          callId: id,
          call_id: id,
          result: result ?? null,
          isError: false,
          is_error: false
        })
        void invoke('sclip_agent_audit', { action: 'record', callId: id, tool, projectId, phase: 'completed' })
      } catch (err: any) {
        const result = err?.code === 'REVISION_MISMATCH'
          ? {
              code: 'REVISION_MISMATCH',
              expected: err.expected,
              actual: err.actual,
              operation: err.operation,
            }
          : err.message || String(err)
        await invoke('handle_tool_result', {
          callId: id,
          call_id: id,
          result,
          isError: true,
          is_error: true
        }).catch(() => undefined)
        void invoke('sclip_agent_audit', {
          action: 'record', callId: id, tool, projectId, phase: 'failed',
          detail: err?.message || String(err),
        })
      } finally {
        activeToolCallIds.delete(id)
        recentlyHandledToolCallIds.set(id, Date.now())
      }
    })

    return unlisten
  } catch {
    isInitialized = false
    console.error('[Sclip MCP Bridge] Failed to attach listener')
  }
}
