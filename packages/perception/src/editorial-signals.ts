import type { SemanticMediaMap, SemanticReviewCandidate } from './semantic-media-map.ts'

/**
 * Small, specialist editorial scorers. They turn grounded observations into
 * explainable opportunities for Hermes' one general plan; they never choose a
 * final structure or mutate the FreeCut timeline.
 */
export type EditorialSignalKind =
  | 'hook_opportunity'
  | 'pacing_review'
  | 'repetition_review'
  | 'caption_opportunity'
  | 'broll_opportunity'
  | 'audio_review'

export interface EditorialSignal {
  id: string
  kind: EditorialSignalKind
  priority: number
  startSec: number
  endSec: number
  evidenceIds: string[]
  rationale: string
  requiresCreatorReview: true
}

function signalFromCandidate(candidate: SemanticReviewCandidate, kind: EditorialSignalKind, priority: number, rationale: string): EditorialSignal {
  return {
    id: `signal:${kind}:${candidate.id}`,
    kind,
    priority: Number(Math.max(0, Math.min(1, priority)).toFixed(3)),
    startSec: candidate.startSec,
    endSec: candidate.endSec,
    evidenceIds: [candidate.id],
    rationale,
    requiresCreatorReview: true,
  }
}

export function buildEditorialSignals(map: SemanticMediaMap): EditorialSignal[] {
  const signals: EditorialSignal[] = []
  for (const candidate of map.reviewCandidates) {
    switch (candidate.kind) {
      case 'hook_candidate':
        signals.push(signalFromCandidate(candidate, 'hook_opportunity', candidate.confidence, 'An early, grounded speech cue may be useful as an opening hook.'))
        break
      case 'repeated_line':
      case 'retake_candidate':
        signals.push(signalFromCandidate(candidate, 'repetition_review', candidate.confidence, 'Grounded repeated speech may be a retake or redundant delivery; choose the retained take editorially.'))
        break
      case 'filler_language':
      case 'tangent_candidate':
        signals.push(signalFromCandidate(candidate, 'pacing_review', candidate.confidence, 'Grounded speech evidence suggests a possible pacing improvement; this is not an automatic cut.'))
        break
      case 'speech_gap':
        signals.push(signalFromCandidate(candidate, 'audio_review', candidate.confidence, 'A transcript gap needs waveform/audio verification before a pause is changed.'))
        break
      case 'key_claim':
      case 'topic_transition':
        signals.push(signalFromCandidate(candidate, 'caption_opportunity', candidate.confidence, 'A grounded key idea or topic change may benefit from timed captions or a graphic.'))
        break
      default:
        break
    }
  }
  for (const [index, moment] of map.visualMoments.entries()) {
    if (!moment.scene?.action && !moment.scene?.subjects?.length && !moment.scene?.setting) continue
    signals.push({
      id: `signal:broll:${index}`,
      kind: 'broll_opportunity',
      priority: 0.4,
      startSec: moment.timeSec,
      endSec: moment.timeSec,
      evidenceIds: [`visual:${index}`],
      rationale: `Source-footage observation (${moment.text}) can guide a related local B-roll search; it does not prove a replacement is needed.`,
      requiresCreatorReview: true,
    })
  }
  return signals.sort((left, right) => right.priority - left.priority || left.startSec - right.startSec || left.id.localeCompare(right.id))
}
