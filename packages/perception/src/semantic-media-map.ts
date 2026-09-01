/**
 * A grounded, deterministic joining layer for the evidence SCLIP already
 * collects about source media.  It deliberately produces *review candidates*,
 * never automatic cuts: deciding whether a repeated line or filler is useful
 * remains an editorial decision for Hermes and the creator.
 */

import { buildAssetFingerprint, type SourceEvidenceAnchor } from './evidence.ts'
import { buildEditorialSignals, type EditorialSignal } from './editorial-signals.ts'

export interface SemanticTranscriptWord {
  /** Stable source word identity when supplied by SCLIP's transcript layer. */
  id?: string
  text: string
  startSec: number
  endSec: number
  confidence?: number
  speaker?: string
}

export interface SemanticTranscriptSegment {
  text: string
  startSec: number
  endSec: number
  words?: SemanticTranscriptWord[]
}

export interface SemanticVisualMoment {
  timeSec: number
  text: string
  scene?: {
    shotType?: string
    subjects?: string[]
    action?: string
    setting?: string
  }
}

export interface SemanticReviewCandidate {
  id: string
  kind:
    | 'filler_language'
    | 'repeated_line'
    | 'retake_candidate'
    | 'speech_gap'
    | 'topic_transition'
    | 'hook_candidate'
    | 'key_claim'
    | 'tangent_candidate'
    | 'call_to_action'
    | 'low_confidence'
  startSec: number
  endSec: number
  confidence: number
  evidence: string
  /** Exact source words when timing evidence is available. */
  wordIds?: string[]
  /** Deterministic candidates explain their limits rather than claiming certainty. */
  evidenceType: 'transcript' | 'audio-pending' | 'visual' | 'editorial-model'
  requiresAudioVerification?: true
  /** Always true: the candidate must be reviewed before an edit is made. */
  requiresEditorialReview: true
}

export interface SemanticMediaMap {
  schemaVersion: 3
  /** Bump this when deterministic annotation behavior changes; maps are disposable. */
  analyzerVersion: 'semantic-v3'
  mediaId: string
  /** Source identity only—timeline changes never invalidate this map. */
  sourceAnchor: SourceEvidenceAnchor
  durationSec?: number
  grounding: {
    transcript: { status: 'available' | 'missing'; segmentCount: number }
    visual: { status: 'available' | 'missing'; momentCount: number }
    overall: 'grounded' | 'partial' | 'insufficient'
    limitations: string[]
  }
  spokenMoments: Array<SemanticTranscriptSegment & { averageWordConfidence?: number }>
  visualMoments: SemanticVisualMoment[]
  reviewCandidates: SemanticReviewCandidate[]
  /** Explainable specialist scores for Hermes; never a final edit decision. */
  editorialSignals: EditorialSignal[]
  recommendedNextSteps: string[]
}

export interface BuildSemanticMediaMapOptions {
  mediaId: string
  /** Content hash is preferred; metadata fallback remains explicitly labelled. */
  assetFingerprint?: string
  durationSec?: number
  transcriptSegments?: SemanticTranscriptSegment[]
  visualMoments?: SemanticVisualMoment[]
}

const FILLER_PATTERN = /\b(?:um+|uh+|erm+|ah+|you know|i mean)\b/i
const FILLER_MATCH_PATTERN = /\b(?:um+|uh+|erm+|ah+|you know|i mean)\b/gi
const LONG_SPEECH_GAP_SECONDS = 1.25
const LOW_CONFIDENCE = 0.65
const CTA_PATTERN = /\b(?:subscribe|follow|like(?:\s+this)?|leave a comment|comment below|link in (?:the )?description|check out)\b/i
const TOPIC_TRANSITION_PATTERN = /^(?:today|first|next|then|finally|now|so|let'?s|the (?:first|next|last) thing)\b/i
const HOOK_PATTERN = /\b(?:the (?:biggest|best|worst|secret)|here'?s why|i (?:was|made|learned|found)|you(?:'|’)re doing .* wrong)\b/i

function finiteSeconds(value: number): number {
  return Number(Math.max(0, value).toFixed(3))
}

function normaliseSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function averageWordConfidence(words?: SemanticTranscriptWord[]): number | undefined {
  const confidences = (words ?? [])
    .map((word) => word.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (confidences.length === 0) return undefined
  return Number((confidences.reduce((total, value) => total + value, 0) / confidences.length).toFixed(3))
}

function wordsForMoment(moment: SemanticTranscriptSegment): SemanticTranscriptWord[] {
  return (moment.words ?? []).filter((word) =>
    word.text.trim() && Number.isFinite(word.startSec) && Number.isFinite(word.endSec),
  )
}

function wordIds(words: readonly SemanticTranscriptWord[]): string[] | undefined {
  const ids = words.flatMap((word) => word.id ? [word.id] : [])
  return ids.length ? ids : undefined
}

function candidate(
  value: Omit<SemanticReviewCandidate, 'requiresEditorialReview'>,
): SemanticReviewCandidate {
  return { ...value, requiresEditorialReview: true }
}

/**
 * Join timestamped speech and existing frame-caption observations into a
 * durable semantic map. This function makes no network or model calls.
 */
export function buildSemanticMediaMap(options: BuildSemanticMediaMapOptions): SemanticMediaMap {
  const spokenMoments = [...(options.transcriptSegments ?? [])]
    .filter((segment) => segment.text.trim() && Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec))
    .map((segment) => ({
      ...segment,
      startSec: finiteSeconds(segment.startSec),
      endSec: finiteSeconds(Math.max(segment.startSec, segment.endSec)),
      ...(averageWordConfidence(segment.words) !== undefined
        ? { averageWordConfidence: averageWordConfidence(segment.words) }
        : {}),
    }))
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)

  const visualMoments = [...(options.visualMoments ?? [])]
    .filter((moment) => moment.text.trim() && Number.isFinite(moment.timeSec))
    .map((moment) => ({ ...moment, timeSec: finiteSeconds(moment.timeSec) }))
    .sort((left, right) => left.timeSec - right.timeSec)

  const reviewCandidates: SemanticReviewCandidate[] = []
  for (let index = 0; index < spokenMoments.length; index += 1) {
    const moment = spokenMoments[index]!
    const words = wordsForMoment(moment)
    const fillers = words.filter((word) => FILLER_PATTERN.test(word.text))
    if (fillers.length) {
      reviewCandidates.push(...fillers.map((word, fillerIndex) => candidate({
        id: `filler-${index}-${fillerIndex}`,
        kind: 'filler_language',
        startSec: finiteSeconds(word.startSec),
        endSec: finiteSeconds(word.endSec),
        confidence: 0.9,
        evidence: `Transcript word “${word.text.trim()}” is an unambiguous hesitation/filler candidate.`,
        ...(word.id ? { wordIds: [word.id] } : {}),
        evidenceType: 'transcript',
      })))
    } else {
      const segmentFillers = moment.text.match(FILLER_MATCH_PATTERN)
      if (segmentFillers?.length) {
        reviewCandidates.push(candidate({
          id: `filler-${index}`,
          kind: 'filler_language',
          startSec: moment.startSec,
          endSec: moment.endSec,
          confidence: 0.72,
          evidence: `Transcript contains ${segmentFillers.map((filler) => `“${filler}”`).join(', ')}, but word timing is unavailable.`,
          evidenceType: 'transcript',
        }))
      }
    }

    const uncertainWords = words.filter((word) =>
      typeof word.confidence === 'number' && Number.isFinite(word.confidence) && word.confidence < LOW_CONFIDENCE,
    )
    reviewCandidates.push(...uncertainWords.map((word, confidenceIndex) => candidate({
      id: `low-confidence-${index}-${confidenceIndex}`,
      kind: 'low_confidence',
      startSec: finiteSeconds(word.startSec),
      endSec: finiteSeconds(word.endSec),
      confidence: Number((1 - Math.max(0, word.confidence ?? 0)).toFixed(3)),
      evidence: `The transcript provider assigned “${word.text.trim()}” confidence ${Number((word.confidence ?? 0).toFixed(2))}; verify before using it as an editorial fact.`,
      ...(word.id ? { wordIds: [word.id] } : {}),
      evidenceType: 'transcript',
    })))

    if (CTA_PATTERN.test(moment.text)) {
      reviewCandidates.push(candidate({
        id: `cta-${index}`,
        kind: 'call_to_action',
        startSec: moment.startSec,
        endSec: moment.endSec,
        confidence: 0.8,
        evidence: `Transcript contains a call-to-action phrase: “${moment.text.trim()}”.`,
        ...(wordIds(words) ? { wordIds: wordIds(words) } : {}),
        evidenceType: 'transcript',
      }))
    }
    if (TOPIC_TRANSITION_PATTERN.test(moment.text.trim())) {
      reviewCandidates.push(candidate({
        id: `topic-transition-${index}`,
        kind: 'topic_transition',
        startSec: moment.startSec,
        endSec: moment.endSec,
        confidence: 0.55,
        evidence: `The segment begins with a transition cue and may start a new topic: “${moment.text.trim()}”.`,
        ...(wordIds(words) ? { wordIds: wordIds(words) } : {}),
        evidenceType: 'transcript',
      }))
    }
    if (index <= 2 && HOOK_PATTERN.test(moment.text)) {
      reviewCandidates.push(candidate({
        id: `opening-hook-${index}`,
        kind: 'hook_candidate',
        startSec: moment.startSec,
        endSec: moment.endSec,
        confidence: 0.4,
        evidence: `This early statement matches a lightweight hook heuristic; an editor must judge whether it is actually compelling: “${moment.text.trim()}”.`,
        ...(wordIds(words) ? { wordIds: wordIds(words) } : {}),
        evidenceType: 'transcript',
      }))
    }

    const previous = spokenMoments[index - 1]
    if (!previous) continue
    const previousText = normaliseSpeech(previous.text)
    const currentText = normaliseSpeech(moment.text)
    if (previousText.length >= 8 && previousText === currentText) {
      reviewCandidates.push(candidate({
        id: `repeat-${index - 1}-${index}`,
        kind: 'repeated_line',
        startSec: previous.startSec,
        endSec: moment.endSec,
        confidence: 0.9,
        evidence: `Adjacent transcript segments repeat: “${moment.text.trim()}”.`,
        evidenceType: 'transcript',
      }))
      reviewCandidates.push(candidate({
        id: `retake-${index - 1}-${index}`,
        kind: 'retake_candidate',
        startSec: previous.startSec,
        endSec: moment.endSec,
        confidence: 0.65,
        evidence: 'Exact adjacent repetition can indicate a retake, but the preferred take requires editorial review.',
        evidenceType: 'transcript',
      }))
    }

    const gapStart = previous.endSec
    const gapEnd = moment.startSec
    if (gapEnd - gapStart >= LONG_SPEECH_GAP_SECONDS) {
      reviewCandidates.push(candidate({
        id: `gap-${index - 1}-${index}`,
        kind: 'speech_gap',
        startSec: gapStart,
        endSec: gapEnd,
        confidence: 0.55,
        evidence: `There is a ${Number((gapEnd - gapStart).toFixed(2))}s gap between transcript segments. This is a speech gap, not confirmed silence.`,
        evidenceType: 'audio-pending',
        requiresAudioVerification: true,
      }))
    }
  }

  const transcriptStatus = spokenMoments.length ? 'available' : 'missing'
  const visualStatus = visualMoments.length ? 'available' : 'missing'
  const overall = transcriptStatus === 'available' && visualStatus === 'available'
    ? 'grounded'
    : transcriptStatus === 'available' || visualStatus === 'available'
      ? 'partial'
      : 'insufficient'
  const limitations: string[] = []
  if (transcriptStatus === 'missing') limitations.push('No timestamped transcript is available yet.')
  if (visualStatus === 'missing') limitations.push('No source-footage visual analysis is available yet.')
  limitations.push('Review candidates are evidence for an editor, not approved cuts.')

  const recommendedNextSteps: string[] = []
  if (transcriptStatus === 'missing') recommendedNextSteps.push('Run transcription to ground spoken content and timings.')
  if (visualStatus === 'missing') recommendedNextSteps.push('Run source-footage analysis to ground visual context.')
  if (overall === 'grounded') {
    recommendedNextSteps.push('Ask Hermes to propose a rough-cut plan; review candidates must be confirmed before edits.')
  }

  const map: SemanticMediaMap = {
    schemaVersion: 3,
    analyzerVersion: 'semantic-v3',
    mediaId: options.mediaId,
    sourceAnchor: {
      assetId: options.mediaId,
      assetFingerprint: options.assetFingerprint ?? buildAssetFingerprint({ mediaId: options.mediaId }),
    },
    ...(typeof options.durationSec === 'number' && Number.isFinite(options.durationSec)
      ? { durationSec: finiteSeconds(options.durationSec) }
      : {}),
    grounding: {
      transcript: { status: transcriptStatus, segmentCount: spokenMoments.length },
      visual: { status: visualStatus, momentCount: visualMoments.length },
      overall,
      limitations,
    },
    spokenMoments,
    visualMoments,
    reviewCandidates,
    editorialSignals: [],
    recommendedNextSteps,
  }
  map.editorialSignals = buildEditorialSignals(map)
  return map
}
