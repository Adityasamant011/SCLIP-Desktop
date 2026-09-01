/**
 * SCLIP Project Intelligence Index & Bounded Long-Form Retrieval
 *
 * Provides time-indexed, segment-level intelligence and bounded windowing
 * so Hermes can reason about 30–120+ minute projects without full-timeline
 * payload explosion.
 */

import { buildAssetFingerprint, type SourceEvidenceAnchor } from './evidence.ts'
import type { SemanticTranscriptSegment, SemanticTranscriptWord, SemanticVisualMoment } from './semantic-media-map.ts'

export interface ProjectIntelligenceSegment {
  id: string
  mediaId: string
  sourceStartSec: number
  sourceEndSec: number
  timelinePlacements?: Array<{
    itemId: string
    trackId: string
    timelineStartSec: number
    timelineEndSec: number
    timelineStartFrame: number
    timelineEndFrame: number
  }>
  speech?: {
    text: string
    wordIds?: string[]
    speaker?: string
    confidence?: number
    isFiller?: boolean
    isSpeechGap?: boolean
  }
  visual?: {
    captionText?: string
    sceneType?: string
    shotType?: string
    action?: string
    setting?: string
    subjects?: string[]
    thumbnailRelPath?: string
  }
  audio?: {
    isSilence?: boolean
  }
  provenance: {
    sourceAssetFingerprint?: string
    pixelsAnalyzed: boolean
    semanticVisionPerformed: boolean
    audioAnalyzed: boolean
    transcriptAnalyzed: boolean
    confidence: number
    degraded: boolean
    degradedReason?: string
  }
}

export interface ProjectSummary {
  projectId: string
  projectName?: string
  projectRevision: string
  durationSec: number
  durationFrames: number
  fps: number
  resolution: { width: number; height: number; aspectRatio: string }
  tracks: {
    total: number
    byKind: { video: number; audio: number; text: number; other: number }
  }
  itemCounts: {
    total: number
    video: number
    audio: number
    text: number
    other: number
  }
  mediaAssets: {
    total: number
    withTranscript: number
    withVisualAnalysis: number
  }
  speechOverview: {
    transcriptAvailable: boolean
    totalSpokenDurationSec: number
    speechCoveragePercent: number
    speakerCount: number
    totalWords: number
  }
  visualOverview: {
    visualAnalysisAvailable: boolean
    analyzedMomentsCount: number
  }
  segmentCount: number
  markersCount: number
  degraded: boolean
  degradedReasons?: string[]
}

export interface TimelineWindowOptions {
  startSec: number
  endSec: number
  tracks?: string[]
  detailLevel?: 'summary' | 'standard' | 'deep'
  includeTranscript?: boolean
  includeVisual?: boolean
  includeAudio?: boolean
  includeSegments?: boolean
  maxItems?: number
  maxWords?: number
}

export interface WindowItemSummary {
  id: string
  trackId: string
  type: string
  label?: string
  mediaId?: string
  timelineStartSec: number
  timelineEndSec: number
  timelineStartFrame: number
  timelineEndFrame: number
  sourceStartSec?: number
  sourceEndSec?: number
  sourceDurationSec?: number
  text?: string
  transform?: Record<string, unknown>
  effectsCount?: number
}

export interface WindowTranscriptWord {
  wordId: string
  itemId: string
  mediaId: string
  text: string
  confidence?: number
  speaker?: string
  timelineStartSec: number
  timelineEndSec: number
}

export interface TimelineWindowResult {
  projectId: string
  projectRevision: string
  window: {
    startSec: number
    endSec: number
    startFrame: number
    endFrame: number
    durationSec: number
  }
  items: WindowItemSummary[]
  transcriptWords?: WindowTranscriptWord[]
  visualMoments?: Array<{
    timeSec: number
    text: string
    shotType?: string
    action?: string
    setting?: string
    subjects?: string[]
  }>
  segments?: ProjectIntelligenceSegment[]
  audioOverview?: {
    silenceRanges?: Array<{ startSec: number; endSec: number }>
  }
  truncation: {
    isTruncated: boolean
    maxItemsReached?: boolean
    maxWordsReached?: boolean
    totalItemsInWindow: number
    returnedItemCount: number
  }
  provenance: {
    projectRevision: string
    transcriptAvailable: boolean
    visualAvailable: boolean
    audioAvailable: boolean
  }
}

export interface SegmentInspectionResult {
  projectId: string
  projectRevision: string
  segmentId?: string
  itemId?: string
  segment?: ProjectIntelligenceSegment
  timelineItem?: unknown
  detailedTranscript?: unknown
  visualDetails?: unknown
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function calculateAspectRatio(width: number, height: number): string {
  if (!width || !height) return '16:9'
  const divisor = gcd(Math.round(width), Math.round(height))
  const aspectW = Math.round(width) / divisor
  const aspectH = Math.round(height) / divisor
  if (aspectW === 16 && aspectH === 9) return '16:9'
  if (aspectW === 9 && aspectH === 16) return '9:16'
  if (aspectW === 4 && aspectH === 3) return '4:3'
  if (aspectW === 1 && aspectH === 1) return '1:1'
  return `${aspectW}:${aspectH}`
}

/**
 * Generate a compact, bounded project summary for Hermes orientation.
 */
export function buildProjectSummary(input: {
  projectId: string
  projectName?: string
  projectRevision: string
  fps: number
  width: number
  height: number
  tracks: Array<{ id: string; kind?: string }>
  items: Array<{ id: string; type: string; trackId: string; from: number; durationInFrames: number; mediaId?: string }>
  markersCount?: number
  mediaMetadata?: Array<{
    id: string
    hasTranscript?: boolean
    hasVisualAnalysis?: boolean
    duration?: number
  }>
  transcriptSegmentsByMediaId?: Record<string, SemanticTranscriptSegment[]>
  visualMomentsByMediaId?: Record<string, SemanticVisualMoment[]>
}): ProjectSummary {
  const fps = Math.max(1, input.fps)
  const durationFrames = input.items.reduce((max, item) => Math.max(max, item.from + item.durationInFrames), 0)
  const durationSec = Number((durationFrames / fps).toFixed(3))

  const tracksByKind = { video: 0, audio: 0, text: 0, other: 0 }
  for (const track of input.tracks) {
    const kind = (track.kind || '').toLowerCase()
    if (kind === 'video') tracksByKind.video++
    else if (kind === 'audio') tracksByKind.audio++
    else if (kind === 'text' || kind === 'subtitle') tracksByKind.text++
    else tracksByKind.other++
  }

  const itemCounts = { total: input.items.length, video: 0, audio: 0, text: 0, other: 0 }
  for (const item of input.items) {
    if (item.type === 'video') itemCounts.video++
    else if (item.type === 'audio') itemCounts.audio++
    else if (item.type === 'text') itemCounts.text++
    else itemCounts.other++
  }

  let totalSpokenDurationSec = 0
  let totalWords = 0
  const speakers = new Set<string>()
  let transcriptAvailable = false

  if (input.transcriptSegmentsByMediaId) {
    for (const segments of Object.values(input.transcriptSegmentsByMediaId)) {
      if (segments && segments.length > 0) {
        transcriptAvailable = true
        for (const seg of segments) {
          totalSpokenDurationSec += Math.max(0, seg.endSec - seg.startSec)
          if (seg.words) {
            totalWords += seg.words.length
            for (const w of seg.words) {
              if (w.speaker) speakers.add(w.speaker)
            }
          }
        }
      }
    }
  }

  let visualMomentsCount = 0
  let visualAvailable = false
  if (input.visualMomentsByMediaId) {
    for (const moments of Object.values(input.visualMomentsByMediaId)) {
      if (moments && moments.length > 0) {
        visualAvailable = true
        visualMomentsCount += moments.length
      }
    }
  }

  const mediaAssetsTotal = input.mediaMetadata ? input.mediaMetadata.length : Object.keys(input.transcriptSegmentsByMediaId ?? {}).length
  const mediaWithTranscript = input.mediaMetadata
    ? input.mediaMetadata.filter((m) => m.hasTranscript).length
    : Object.keys(input.transcriptSegmentsByMediaId ?? {}).length
  const mediaWithVisual = input.mediaMetadata
    ? input.mediaMetadata.filter((m) => m.hasVisualAnalysis).length
    : Object.keys(input.visualMomentsByMediaId ?? {}).length

  const speechCoveragePercent = durationSec > 0
    ? Math.min(100, Number(((totalSpokenDurationSec / durationSec) * 100).toFixed(1)))
    : 0

  const degradedReasons: string[] = []
  if (!transcriptAvailable && itemCounts.audio + itemCounts.video > 0) {
    degradedReasons.push('Transcripts are not yet generated for active media.')
  }
  if (!visualAvailable && itemCounts.video > 0) {
    degradedReasons.push('Visual scene analysis is not yet generated for active video.')
  }

  return {
    projectId: input.projectId,
    projectName: input.projectName,
    projectRevision: input.projectRevision,
    durationSec,
    durationFrames,
    fps,
    resolution: {
      width: input.width,
      height: input.height,
      aspectRatio: calculateAspectRatio(input.width, input.height),
    },
    tracks: {
      total: input.tracks.length,
      byKind: tracksByKind,
    },
    itemCounts,
    mediaAssets: {
      total: mediaAssetsTotal,
      withTranscript: mediaWithTranscript,
      withVisualAnalysis: mediaWithVisual,
    },
    speechOverview: {
      transcriptAvailable,
      totalSpokenDurationSec: Number(totalSpokenDurationSec.toFixed(2)),
      speechCoveragePercent,
      speakerCount: speakers.size,
      totalWords,
    },
    visualOverview: {
      visualAnalysisAvailable: visualAvailable,
      analyzedMomentsCount: visualMomentsCount,
    },
    segmentCount: totalWords > 0 ? Math.ceil(totalWords / 15) : itemCounts.total,
    markersCount: input.markersCount ?? 0,
    degraded: degradedReasons.length > 0,
    degradedReasons: degradedReasons.length > 0 ? degradedReasons : undefined,
  }
}

/**
 * Build a bounded timeline window query result strictly within [startSec, endSec].
 */
export function buildTimelineWindow(input: {
  projectId: string
  projectRevision: string
  fps: number
  options: TimelineWindowOptions
  tracks: Array<{ id: string; name?: string; kind?: string }>
  items: Array<{
    id: string
    type: string
    trackId: string
    from: number
    durationInFrames: number
    label?: string
    mediaId?: string
    text?: string
    sourceStart?: number
    sourceDuration?: number
    transform?: Record<string, unknown>
    effects?: Array<{ id: string }>
  }>
  transcriptTokens?: Array<{
    wordId: string
    itemId: string
    mediaId: string
    text: string
    confidence?: number
    speaker?: string
    startFrame: number
    endFrame: number
    sourceStart: number
    sourceEnd: number
  }>
  visualMomentsByMediaId?: Record<string, SemanticVisualMoment[]>
  silenceRanges?: Array<{ startSec: number; endSec: number }>
}): TimelineWindowResult {
  const fps = Math.max(1, input.fps)
  const startSec = Math.max(0, Number(input.options.startSec || 0))
  // Default window is 30s, capped at 300s (5 minutes) max per query for safety
  const rawEndSec = typeof input.options.endSec === 'number' ? input.options.endSec : startSec + 30
  const maxAllowedDurationSec = 300
  const endSec = Math.min(startSec + maxAllowedDurationSec, Math.max(startSec + 0.1, rawEndSec))

  const startFrame = Math.floor(startSec * fps)
  const endFrame = Math.ceil(endSec * fps)
  const maxItems = Math.max(1, Math.min(200, input.options.maxItems ?? 100))
  const maxWords = Math.max(1, Math.min(1000, input.options.maxWords ?? 300))

  const trackFilter = input.options.tracks?.length ? new Set(input.options.tracks) : null

  // Filter overlapping items
  const overlappingItems = input.items.filter((item) => {
    if (trackFilter && !trackFilter.has(item.trackId)) return false
    const itemStart = item.from
    const itemEnd = item.from + item.durationInFrames
    return itemStart < endFrame && itemEnd > startFrame
  })

  const returnedItems = overlappingItems.slice(0, maxItems).map((item): WindowItemSummary => {
    const itemStartSec = Number((item.from / fps).toFixed(3))
    const itemEndSec = Number(((item.from + item.durationInFrames) / fps).toFixed(3))
    const srcStartSec = typeof item.sourceStart === 'number' ? Number((item.sourceStart / fps).toFixed(3)) : undefined
    const srcDurSec = typeof item.sourceDuration === 'number' ? Number((item.sourceDuration / fps).toFixed(3)) : undefined

    return {
      id: item.id,
      trackId: item.trackId,
      type: item.type,
      label: item.label,
      mediaId: item.mediaId,
      timelineStartSec: itemStartSec,
      timelineEndSec: itemEndSec,
      timelineStartFrame: item.from,
      timelineEndFrame: item.from + item.durationInFrames,
      sourceStartSec: srcStartSec,
      sourceEndSec: srcStartSec !== undefined && srcDurSec !== undefined ? Number((srcStartSec + srcDurSec).toFixed(3)) : undefined,
      sourceDurationSec: srcDurSec,
      text: item.text,
      transform: input.options.detailLevel === 'deep' ? item.transform : undefined,
      effectsCount: item.effects?.length,
    }
  })

  // Filter overlapping transcript words
  let windowWords: WindowTranscriptWord[] | undefined
  if (input.options.includeTranscript !== false && input.transcriptTokens) {
    const overlappingTokens = input.transcriptTokens.filter((token) => {
      return token.startFrame < endFrame && token.endFrame > startFrame
    })
    windowWords = overlappingTokens.slice(0, maxWords).map((t) => ({
      wordId: t.wordId,
      itemId: t.itemId,
      mediaId: t.mediaId,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
      timelineStartSec: Number((t.startFrame / fps).toFixed(3)),
      timelineEndSec: Number((t.endFrame / fps).toFixed(3)),
    }))
  }

  // Filter overlapping visual moments
  let visualMoments: TimelineWindowResult['visualMoments']
  if (input.options.includeVisual && input.visualMomentsByMediaId) {
    const moments: Array<{ timeSec: number; text: string; shotType?: string; action?: string; setting?: string; subjects?: string[] }> = []
    for (const item of returnedItems) {
      if (!item.mediaId) continue
      const assetMoments = input.visualMomentsByMediaId[item.mediaId] ?? []
      for (const m of assetMoments) {
        // Map source moment to timeline time
        if (item.sourceStartSec !== undefined && m.timeSec >= item.sourceStartSec && m.timeSec <= (item.sourceEndSec ?? Infinity)) {
          const offset = m.timeSec - item.sourceStartSec
          const timelineTime = Number((item.timelineStartSec + offset).toFixed(3))
          if (timelineTime >= startSec && timelineTime <= endSec) {
            moments.push({
              timeSec: timelineTime,
              text: m.text,
              shotType: m.scene?.shotType,
              action: m.scene?.action,
              setting: m.scene?.setting,
              subjects: m.scene?.subjects,
            })
          }
        }
      }
    }
    if (moments.length) {
      visualMoments = moments.sort((a, b) => a.timeSec - b.timeSec).slice(0, 50)
    }
  }

  // Audio overview in window
  let audioOverview: TimelineWindowResult['audioOverview']
  if (input.options.includeAudio && input.silenceRanges) {
    const overlappingSilence = input.silenceRanges
      .filter((r) => r.startSec < endSec && r.endSec > startSec)
      .map((r) => ({
        startSec: Math.max(startSec, r.startSec),
        endSec: Math.min(endSec, r.endSec),
      }))
    if (overlappingSilence.length) {
      audioOverview = { silenceRanges: overlappingSilence }
    }
  }

  const isTruncated = overlappingItems.length > maxItems || (input.transcriptTokens ? input.transcriptTokens.filter((t) => t.startFrame < endFrame && t.endFrame > startFrame).length > maxWords : false)

  return {
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    window: {
      startSec,
      endSec,
      startFrame,
      endFrame,
      durationSec: Number((endSec - startSec).toFixed(3)),
    },
    items: returnedItems,
    transcriptWords: windowWords,
    visualMoments,
    audioOverview,
    truncation: {
      isTruncated,
      maxItemsReached: overlappingItems.length > maxItems,
      maxWordsReached: windowWords ? windowWords.length >= maxWords : false,
      totalItemsInWindow: overlappingItems.length,
      returnedItemCount: returnedItems.length,
    },
    provenance: {
      projectRevision: input.projectRevision,
      transcriptAvailable: !!(windowWords && windowWords.length > 0),
      visualAvailable: !!(visualMoments && visualMoments.length > 0),
      audioAvailable: !!(audioOverview && audioOverview.silenceRanges && audioOverview.silenceRanges.length > 0),
    },
  }
}
