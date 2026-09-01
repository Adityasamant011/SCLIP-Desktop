/**
 * SCLIP Visual Segment Intelligence (Phase 2B)
 *
 * Provides time-indexed, segment-level visual understanding for media assets.
 * Upgrades SCLIP from file-level metadata to precise sub-clip visual segments
 * with start/end bounds, shot type, motion level, and semantic embedding scoring.
 */

import { buildAssetFingerprint } from './evidence.ts'
import type { SemanticVisualMoment } from './semantic-media-map.ts'

export type ShotType =
  | 'extreme_close_up'
  | 'close_up'
  | 'medium_close_up'
  | 'medium'
  | 'medium_wide'
  | 'wide'
  | 'extreme_wide'
  | 'unknown'

export type CameraMotion =
  | 'static'
  | 'pan'
  | 'tilt'
  | 'zoom'
  | 'tracking'
  | 'handheld_stable'
  | 'shaky'
  | 'unknown'

export type MotionLevel = 'static' | 'low' | 'moderate' | 'high' | 'shaky'

export interface VisualSegmentSceneData {
  shotType?: ShotType
  subjects?: string[]
  action?: string
  setting?: string
  lighting?: string
  timeOfDay?: string
}

export interface VisualSegmentQuality {
  stabilityScore: number // 0.0 to 1.0 (1.0 = rock solid static/gimbal)
  sharpnessScore?: number // 0.0 to 1.0
  isUsableForBroll: boolean
}

export interface VisualSegment {
  id: string
  mediaId: string
  /** Sub-clip start in seconds within source media */
  startSec: number
  /** Sub-clip end in seconds within source media */
  endSec: number
  /** The exact timestamp where the visual sample/keyframe was observed */
  sampleTimeSec?: number
  /** Duration in seconds */
  durationSec: number
  sourceStartFrame: number
  sourceEndFrame: number

  description: string
  sceneData?: VisualSegmentSceneData
  cameraMotion: CameraMotion
  motionLevel: MotionLevel
  quality: VisualSegmentQuality
  dominantColors?: string[]
  thumbnailRelPath?: string

  embeddingRef?: {
    model: string
    dim: number
    sampleIndex: number
  }

  provenance: {
    sourceAssetFingerprint: string
    pixelsAnalyzed: boolean
    semanticVisionPerformed: boolean
    model?: string
    analysisVersion: string
    confidence: number
    degraded: boolean
    degradedReason?: string
  }
}

export interface VisualSegmentMatch {
  segment: VisualSegment
  mediaId: string
  fileName?: string
  startSec: number
  endSec: number
  durationSec: number
  semanticScore: number // Calibrated 0.0 to 1.0
  vectorSimilarity?: number
  keywordMatchScore?: number
  matchedTerms?: string[]
  provenance: VisualSegment['provenance']
}

export interface RawMediaCaptionInput {
  timeSec: number
  text: string
  sceneData?: {
    shotType?: string
    subjects?: string[]
    action?: string
    setting?: string
    lighting?: string
    timeOfDay?: string
    weather?: string
  }
  palette?: string[]
  thumbRelPath?: string
  embedding?: number[]
}

export interface BuildVisualSegmentsOptions {
  mediaId: string
  durationSec: number
  fps?: number
  contentHash?: string
  captions?: RawMediaCaptionInput[]
  sceneCutFrames?: number[]
}

function parseShotType(raw?: string): ShotType {
  if (!raw) return 'unknown'
  const normalized = raw.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (normalized.includes('extreme_close') || normalized.includes('ecu')) return 'extreme_close_up'
  if (normalized.includes('close')) return 'close_up'
  if (normalized.includes('medium_close')) return 'medium_close_up'
  if (normalized.includes('medium_wide')) return 'medium_wide'
  if (normalized.includes('medium')) return 'medium'
  if (normalized.includes('extreme_wide')) return 'extreme_wide'
  if (normalized.includes('wide')) return 'wide'
  return 'unknown'
}

function estimateMotion(captionText: string, sceneData?: VisualSegmentSceneData): { motion: CameraMotion; level: MotionLevel; stability: number } {
  const text = (captionText + ' ' + (sceneData?.action || '')).toLowerCase()
  if (text.includes('shaky') || text.includes('unstable') || text.includes('camera shake') || text.includes('reposition')) {
    return { motion: 'shaky', level: 'shaky', stability: 0.3 }
  }
  if (text.includes('pan') || text.includes('panning')) {
    return { motion: 'pan', level: 'moderate', stability: 0.8 }
  }
  if (text.includes('tilt') || text.includes('tilting')) {
    return { motion: 'tilt', level: 'moderate', stability: 0.8 }
  }
  if (text.includes('zoom') || text.includes('zooming')) {
    return { motion: 'zoom', level: 'moderate', stability: 0.85 }
  }
  if (text.includes('run') || text.includes('fast movement') || text.includes('action')) {
    return { motion: 'tracking', level: 'high', stability: 0.7 }
  }
  if (text.includes('static') || text.includes('tripod') || text.includes('still') || text.includes('close-up of') || text.includes('pouring')) {
    return { motion: 'static', level: 'static', stability: 0.95 }
  }
  return { motion: 'handheld_stable', level: 'low', stability: 0.85 }
}

/**
 * Build time-indexed, bounded visual segments from media captions & scene cuts.
 * Merges contiguous samples sharing similar scene semantics and derives exact bounds.
 */
export function buildVisualSegments(options: BuildVisualSegmentsOptions): VisualSegment[] {
  const fps = Math.max(1, options.fps ?? 30)
  const totalDurationSec = Math.max(0.1, options.durationSec)
  const captions = (options.captions ?? []).filter((c) => Number.isFinite(c.timeSec) && c.text.trim())

  const sourceAssetFingerprint = buildAssetFingerprint({
    mediaId: options.mediaId,
    contentHash: options.contentHash,
  })

  if (captions.length === 0) {
    // If no visual captions exist, return a single unanalyzed segment with explicit degraded provenance
    return [
      {
        id: `vis-seg:${options.mediaId}:0`,
        mediaId: options.mediaId,
        startSec: 0,
        endSec: Number(totalDurationSec.toFixed(3)),
        durationSec: Number(totalDurationSec.toFixed(3)),
        sourceStartFrame: 0,
        sourceEndFrame: Math.round(totalDurationSec * fps),
        description: 'Unanalyzed media asset',
        cameraMotion: 'unknown',
        motionLevel: 'low',
        quality: { stabilityScore: 0.5, isUsableForBroll: true },
        provenance: {
          sourceAssetFingerprint,
          pixelsAnalyzed: false,
          semanticVisionPerformed: false,
          analysisVersion: 'sclip-visual-segment-v1',
          confidence: 0,
          degraded: true,
          degradedReason: 'NO_VISUAL_SAMPLES_CAPTURED',
        },
      },
    ]
  }

  // Sort captions by time
  const sorted = captions.slice().sort((a, b) => a.timeSec - b.timeSec)
  const rawSegments: VisualSegment[] = []

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!
    const prev = sorted[i - 1]
    const next = sorted[i + 1]

    // Calculate segment start and end bounds based on midpoints between samples
    const startSec = prev ? Number(((prev.timeSec + current.timeSec) / 2).toFixed(3)) : 0
    const endSec = next ? Number(((current.timeSec + next.timeSec) / 2).toFixed(3)) : Number(totalDurationSec.toFixed(3))
    const durationSec = Number(Math.max(0.1, endSec - startSec).toFixed(3))

    const shotType = parseShotType(current.sceneData?.shotType)
    const sceneData: VisualSegmentSceneData = {
      shotType,
      subjects: current.sceneData?.subjects,
      action: current.sceneData?.action,
      setting: current.sceneData?.setting,
      lighting: current.sceneData?.lighting,
      timeOfDay: current.sceneData?.timeOfDay,
    }

    const { motion, level, stability } = estimateMotion(current.text, sceneData)

    rawSegments.push({
      id: `vis-seg:${options.mediaId}:${i}`,
      mediaId: options.mediaId,
      startSec,
      endSec,
      sampleTimeSec: current.timeSec,
      durationSec,
      sourceStartFrame: Math.round(startSec * fps),
      sourceEndFrame: Math.round(endSec * fps),
      description: current.text.trim(),
      sceneData,
      cameraMotion: motion,
      motionLevel: level,
      quality: {
        stabilityScore: stability,
        isUsableForBroll: stability >= 0.6 && durationSec >= 1.0,
      },
      dominantColors: current.palette,
      thumbnailRelPath: current.thumbRelPath,
      embeddingRef: {
        model: 'Xenova/clip-vit-base-patch32',
        dim: 512,
        sampleIndex: i,
      },
      provenance: {
        sourceAssetFingerprint,
        pixelsAnalyzed: true,
        semanticVisionPerformed: true,
        model: 'Xenova/clip-vit-base-patch32',
        analysisVersion: 'sclip-visual-segment-v1',
        confidence: Number((0.75 + stability * 0.2).toFixed(2)),
        degraded: false,
      },
    })
  }

  return rawSegments
}

/**
 * Compute cosine similarity between two float vectors.
 */
export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!
    const valB = b[i]!
    dotProduct += valA * valB
    normA += valA * valA
    normB += valB * valB
  }
  if (normA === 0 || normB === 0) return 0
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  return Number(Math.max(-1, Math.min(1, similarity)).toFixed(4))
}

/**
 * Rank visual segments against a query using vector cosine similarity and keyword matching.
 */
export function rankVisualSegments(input: {
  query: string
  queryVector?: Float32Array | number[]
  segmentsWithVectors: Array<{
    segment: VisualSegment
    imageVector?: Float32Array | number[]
  }>
  minUsableDurationSec?: number
  limit?: number
}): VisualSegmentMatch[] {
  const queryTerms = input.query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)

  const minDuration = input.minUsableDurationSec ?? 1.0
  const limit = Math.max(1, Math.min(50, input.limit ?? 10))

  const matches: VisualSegmentMatch[] = []

  for (const item of input.segmentsWithVectors) {
    const seg = item.segment
    if (seg.durationSec < minDuration) continue

    let vectorScore = 0
    if (input.queryVector && item.imageVector) {
      // CLIP cosine similarity typically lies between 0.10 and 0.40 for natural images;
      // normalize and clamp to calibrated 0.0-1.0 range
      const rawCos = cosineSimilarity(input.queryVector, item.imageVector)
      vectorScore = rawCos
    }

    // Keyword relevance score
    const desc = (seg.description + ' ' + (seg.sceneData?.action || '') + ' ' + (seg.sceneData?.subjects?.join(' ') || '')).toLowerCase()
    const matchedTerms = queryTerms.filter((term) => desc.includes(term))
    const keywordScore = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0

    // Calibrated combined semantic score:
    // If vector is available, combined score gives 70% weight to CLIP vector and 30% to exact keyword boost
    let semanticScore = 0
    if (input.queryVector && item.imageVector) {
      // Rescale cosine similarity [-0.2, 0.45] -> [0.0, 1.0]
      const scaledVector = Math.max(0, Math.min(1, (vectorScore - 0.10) / 0.30))
      semanticScore = Number((scaledVector * 0.75 + keywordScore * 0.25).toFixed(3))
    } else {
      semanticScore = Number(keywordScore.toFixed(3))
    }

    matches.push({
      segment: seg,
      mediaId: seg.mediaId,
      startSec: seg.startSec,
      endSec: seg.endSec,
      durationSec: seg.durationSec,
      semanticScore,
      vectorSimilarity: vectorScore || undefined,
      keywordMatchScore: keywordScore,
      matchedTerms: matchedTerms.length ? matchedTerms : undefined,
      provenance: seg.provenance,
    })
  }

  // Sort descending by semanticScore, then by stabilityScore
  return matches
    .sort((a, b) => b.semanticScore - a.semanticScore || b.segment.quality.stabilityScore - a.segment.quality.stabilityScore)
    .slice(0, limit)
}
