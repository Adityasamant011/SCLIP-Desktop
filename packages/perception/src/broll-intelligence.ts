/**
 * SCLIP B-Roll Editorial Intelligence (Phase 2C)
 *
 * Implements intent-driven B-roll search, composite candidate ranking (relevance + stability),
 * calibrated match distribution policy (CLEAR_MATCH / AMBIGUOUS / NO_MATCH), sub-range refinement,
 * and structured missing-asset user fallback requests.
 */

import type {
  VisualSegment,
  VisualSegmentMatch,
  ShotType,
  CameraMotion,
  MotionLevel,
} from './visual-segments.ts'

export type BrollPurpose =
  | 'illustrative'
  | 'contextual'
  | 'seam_cover'
  | 'emotional'
  | 'pacing'

export interface BrollIntent {
  concept: string
  purpose: BrollPurpose
  targetDialogueRange: {
    startSec: number
    endSec: number
  }
  desiredDurationSec?: number
  desiredShotType?: ShotType
  desiredMotion?: CameraMotion
  requiredKeywords?: string[]
  avoidKeywords?: string[]
}

export interface BrollCandidate {
  mediaId: string
  segmentId: string
  sourceStartSec: number
  sourceEndSec: number
  durationSec: number
  sourceStartFrame: number
  sourceEndFrame: number
  refinedRange: {
    sourceStartSec: number
    sourceEndSec: number
    durationSec: number
    sourceStartFrame: number
    sourceEndFrame: number
  }
  semanticScore: number
  stabilityScore: number
  compositeScore: number
  shotType?: ShotType
  motionLevel?: MotionLevel
  cameraMotion?: CameraMotion
  description: string
  thumbnailRelPath?: string
  isUsable: boolean
  provenance: VisualSegment['provenance']
}

export type BrollMatchTier = 'CLEAR_MATCH' | 'AMBIGUOUS_MATCHES' | 'NO_MATCH'

export interface BrollAssetRequest {
  targetRange: { startSec: number; endSec: number }
  concept: string
  reason: string
  suggestedAssetDescription: string
  actionOptions: Array<'import_asset' | 'keep_a_roll' | 'skip'>
}

export interface BrollMatchEvaluation {
  tier: BrollMatchTier
  intent: BrollIntent
  topCandidate?: BrollCandidate
  alternativeCandidates: BrollCandidate[]
  confidenceGap: number
  actionRecommended: 'EXECUTE' | 'PROPOSE' | 'ASK_USER' | 'SKIP'
  assetRequest?: BrollAssetRequest
}

export interface RefineSubRangeOptions {
  segment: VisualSegment
  desiredDurationSec: number
  fps?: number
  momentCenterSec?: number
}

/**
 * Refine a coarse visual segment (e.g. 30s) to a tight, usable sub-clip around
 * the key action moment matching the desired dialogue duration.
 */
export function refineBrollSubRange(options: RefineSubRangeOptions): {
  sourceStartSec: number
  sourceEndSec: number
  durationSec: number
  sourceStartFrame: number
  sourceEndFrame: number
} {
  const fps = Math.max(1, options.fps ?? 30)
  const segStart = options.segment.startSec
  const segEnd = options.segment.endSec
  const segDuration = options.segment.durationSec

  const targetDuration = Math.min(segDuration, Math.max(1.0, options.desiredDurationSec))
  const centerSec = options.momentCenterSec ?? options.segment.sampleTimeSec ?? (segStart + segEnd) / 2

  let sourceStartSec = Math.max(segStart, centerSec - targetDuration / 2)
  let sourceEndSec = sourceStartSec + targetDuration

  if (sourceEndSec > segEnd) {
    sourceEndSec = segEnd
    sourceStartSec = Math.max(segStart, sourceEndSec - targetDuration)
  }

  sourceStartSec = Number(sourceStartSec.toFixed(3))
  sourceEndSec = Number(sourceEndSec.toFixed(3))
  const durationSec = Number((sourceEndSec - sourceStartSec).toFixed(3))

  return {
    sourceStartSec,
    sourceEndSec,
    durationSec,
    sourceStartFrame: Math.round(sourceStartSec * fps),
    sourceEndFrame: Math.round(sourceEndSec * fps),
  }
}

/**
 * Rank visual segment matches into composite B-roll candidates incorporating
 * semantic relevance, stability, shot type, and quality usability.
 */
export function rankBrollCandidates(input: {
  intent: BrollIntent
  matches: VisualSegmentMatch[]
  fps?: number
}): BrollCandidate[] {
  const fps = input.fps ?? 30
  const targetDuration = input.intent.desiredDurationSec ?? Math.max(1.5, input.intent.targetDialogueRange.endSec - input.intent.targetDialogueRange.startSec)

  const candidates: BrollCandidate[] = []

  for (const match of input.matches) {
    const seg = match.segment
    const stability = seg.quality.stabilityScore

    // Shaky footage penalty: if stability is poor (<0.5), slash composite rank
    const stabilityMultiplier = stability < 0.5 ? 0.4 : 1.0

    // Duration fit score
    const durationFit = seg.durationSec >= targetDuration ? 1.0 : seg.durationSec / targetDuration

    // Shot type preference bonus if matched
    let shotBonus = 0
    if (input.intent.desiredShotType && seg.sceneData?.shotType === input.intent.desiredShotType) {
      shotBonus = 0.05
    }

    // Composite score formulation (inspectable components)
    const rawComposite = (match.semanticScore * 0.65 + stability * 0.20 + durationFit * 0.15 + shotBonus) * stabilityMultiplier
    const compositeScore = Number(Math.max(0, Math.min(1, rawComposite)).toFixed(3))

    const refined = refineBrollSubRange({
      segment: seg,
      desiredDurationSec: targetDuration,
      fps,
    })

    candidates.push({
      mediaId: match.mediaId,
      segmentId: seg.id,
      sourceStartSec: seg.startSec,
      sourceEndSec: seg.endSec,
      durationSec: seg.durationSec,
      sourceStartFrame: seg.sourceStartFrame,
      sourceEndFrame: seg.sourceEndFrame,
      refinedRange: refined,
      semanticScore: match.semanticScore,
      stabilityScore: stability,
      compositeScore,
      shotType: seg.sceneData?.shotType,
      motionLevel: seg.motionLevel,
      cameraMotion: seg.cameraMotion,
      description: seg.description,
      thumbnailRelPath: seg.thumbnailRelPath,
      isUsable: seg.quality.isUsableForBroll && compositeScore >= 0.35,
      provenance: seg.provenance,
    })
  }

  // Sort descending by compositeScore
  return candidates.sort((a, b) => b.compositeScore - a.compositeScore)
}

/**
 * Evaluate the candidate score distribution to classify match confidence
 * into CLEAR_MATCH, AMBIGUOUS_MATCHES, or NO_MATCH (Ask User fallback).
 */
export function evaluateBrollCandidates(input: {
  intent: BrollIntent
  candidates: BrollCandidate[]
}): BrollMatchEvaluation {
  const { intent, candidates } = input

  if (candidates.length === 0 || candidates[0]!.compositeScore < 0.40) {
    // NO PLAUSIBLE MATCH -> Structured Ask-User request
    return {
      tier: 'NO_MATCH',
      intent,
      alternativeCandidates: [],
      confidenceGap: 0,
      actionRecommended: 'ASK_USER',
      assetRequest: {
        targetRange: intent.targetDialogueRange,
        concept: intent.concept,
        reason: `No matching footage for "${intent.concept}" was found in your imported media library.`,
        suggestedAssetDescription: `A clean, stable clip depicting ${intent.concept}.`,
        actionOptions: ['import_asset', 'keep_a_roll', 'skip'],
      },
    }
  }

  const top = candidates[0]!
  const second = candidates[1]
  const confidenceGap = second ? Number((top.compositeScore - second.compositeScore).toFixed(3)) : 1.0

  if (top.compositeScore >= 0.65 && (confidenceGap >= 0.08 || top.compositeScore >= 0.90) && top.isUsable) {
    // CLEAR MATCH -> Dominant single candidate
    return {
      tier: 'CLEAR_MATCH',
      intent,
      topCandidate: top,
      alternativeCandidates: candidates.slice(1, 3),
      confidenceGap,
      actionRecommended: 'PROPOSE',
    }
  }

  // AMBIGUOUS MATCHES -> Multiple viable candidates
  return {
    tier: 'AMBIGUOUS_MATCHES',
    intent,
    topCandidate: top,
    alternativeCandidates: candidates.slice(1, 4),
    confidenceGap,
    actionRecommended: 'PROPOSE',
  }
}

/**
 * Compute crop and scale transform parameters for fitting B-roll media into
 * the project canvas without distortion.
 */
export function computeBrollCropTransform(params: {
  sourceWidth: number
  sourceHeight: number
  canvasWidth: number
  canvasHeight: number
}): {
  scale: number
  crop: { x: number; y: number; width: number; height: number }
  isDegradedCenterCrop: boolean
} {
  const sourceAspect = params.sourceWidth / Math.max(1, params.sourceHeight)
  const canvasAspect = params.canvasWidth / Math.max(1, params.canvasHeight)

  if (Math.abs(sourceAspect - canvasAspect) < 0.01) {
    // Same aspect ratio
    return {
      scale: 1.0,
      crop: { x: 0, y: 0, width: params.sourceWidth, height: params.sourceHeight },
      isDegradedCenterCrop: false,
    }
  }

  if (sourceAspect > canvasAspect) {
    // Source is wider than canvas (e.g. 16:9 source in 9:16 project)
    // Scale by height, crop horizontal center
    const visibleWidth = params.sourceHeight * canvasAspect
    const cropX = (params.sourceWidth - visibleWidth) / 2
    return {
      scale: params.canvasHeight / params.sourceHeight,
      crop: {
        x: Math.round(cropX),
        y: 0,
        width: Math.round(visibleWidth),
        height: params.sourceHeight,
      },
      isDegradedCenterCrop: true,
    }
  } else {
    // Source is taller than canvas (e.g. 9:16 source in 16:9 project)
    // Scale by width, crop vertical center
    const visibleHeight = params.sourceWidth / canvasAspect
    const cropY = (params.sourceHeight - visibleHeight) / 2
    return {
      scale: params.canvasWidth / params.sourceWidth,
      crop: {
        x: 0,
        y: Math.round(cropY),
        width: params.sourceWidth,
        height: Math.round(visibleHeight),
      },
      isDegradedCenterCrop: true,
    }
  }
}
