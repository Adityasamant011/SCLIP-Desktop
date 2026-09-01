/**
 * SCLIP General Editorial Reasoning & Multimodal Integration (Phase 5)
 *
 * Provides:
 * 1. EditorialEvidenceBundle — Bounded multimodal evidence assembled by SCLIP for Hermes.
 * 2. EditorialDecision — The reviewable decision contract returned by Hermes.
 * 3. validateEditorialDecision — Deterministic validation ensuring decisions satisfy timeline & evidence constraints.
 * 4. buildEditorialDecisionFixture — Test fixture generator for downstream pipeline verification.
 *
 * NOTE: SCLIP owns evidence assembly, knowledge retrieval, and decision validation.
 * Hermes alone owns creative editorial judgements (decisionKind, intent, actionPolicy, rationale).
 */

import type { VisualSegment } from './visual-segments.ts'
import type { BrollCandidate, BrollMatchEvaluation } from './broll-intelligence.ts'
import type { AudioSegmentEvidence, AudioBoundaryInspection } from './audio-intelligence.ts'
import type { MusicAnalysisResult, DialogueMusicRelationship } from './music-intelligence.ts'

export type EditorialTaskIntent =
  | 'ROUGH_CUT'
  | 'TIGHTEN_PACING'
  | 'CLEAN_DIALOGUE'
  | 'SELECT_RETAKE'
  | 'ADD_BROLL'
  | 'IMPROVE_INTRO'
  | 'IMPROVE_SECTION'
  | 'MUSIC_AWARE_MONTAGE'
  | 'RESTRUCTURE_SECTION'
  | 'GENERAL_EDIT'

export type EpistemicClassification =
  | 'OBSERVED'
  | 'INFERRED'
  | 'HEURISTIC'
  | 'DEGRADED'
  | 'UNKNOWN'

export interface EpistemicEvidenceItem {
  id: string
  classification: EpistemicClassification
  statement: string
  source: string
  confidence: number
}

export type EditorialActionPolicy = 'EXECUTE' | 'PROPOSE' | 'ASK_USER' | 'SKIP'

export interface EditorialDecision {
  id: string
  decisionKind:
    | 'REMOVE_FALSE_START'
    | 'SELECT_RETAKE'
    | 'TIGHTEN_PACING'
    | 'PRESERVE_PAUSE'
    | 'PRESERVE_BREATH'
    | 'ADD_BROLL'
    | 'SMOOTH_AUDIO_SEAM'
    | 'DUCK_MUSIC'
    | 'ALIGN_CUT_TO_BEAT'
    | 'NO_OP_CLEAN_SECTION'
    | 'REQUEST_ASSET'
  targetRange: {
    startSec: number
    endSec: number
    startFrame?: number
    endFrame?: number
  }
  intent: string
  actionPolicy: EditorialActionPolicy
  evidenceRefs: string[]
  knowledgeRefs: string[]
  styleRefs?: string[]
  confidence: number
  ambiguity?: string
  rationale: string
  recommendedOperations?: Array<{
    executor: 'video_apply_script' | 'video_update_item' | 'video_add_clip' | 'video_add_track'
    summary: string
    args: Record<string, unknown>
    risk: 'read_only' | 'reversible' | 'destructive'
  }>
}

export interface EditorialEvidenceBundle {
  schemaVersion: 1
  projectId: string
  projectRevision: string
  objective: string
  taskIntent: EditorialTaskIntent

  timelineSummary: {
    durationSec: number
    durationFrames: number
    fps: number
    itemCount: number
    trackCount: number
  }

  transcriptWindow?: {
    words: Array<{
      id: string
      word: string
      startSec: number
      endSec: number
      confidence: number
      speaker?: string
    }>
    totalWords: number
  }

  visualEvidence: {
    segments: VisualSegment[]
    brollCandidates?: BrollCandidate[]
    brollEvaluation?: BrollMatchEvaluation
  }

  audioEvidence: {
    segments: AudioSegmentEvidence[]
    boundaryInspections: AudioBoundaryInspection[]
  }

  musicEvidence?: {
    analysis?: MusicAnalysisResult
    dialogueRelationship?: DialogueMusicRelationship
  }

  relevantKnowledge: Array<{
    id: string
    title: string
    summary: string
    principles?: string[]
  }>

  creatorStyle?: {
    pacePreference?: 'tight' | 'moderate' | 'relaxed'
    brollFrequency?: 'high' | 'moderate' | 'minimal'
    cutStyle?: 'hard' | 'j_l_cuts' | 'mixed'
    explicitGuidelines?: string[]
  }

  epistemicStatus: {
    observed: string[]
    inferred: string[]
    heuristic: string[]
    degraded: string[]
    unknown: string[]
  }

  limitations: string[]
}

export interface DecisionValidationIssue {
  code: 'UNKNOWN_EVIDENCE' | 'INVALID_RANGE' | 'MISSING_RATIONALE' | 'MISSING_ASSET_VIOLATION'
  decisionId: string
  message: string
}

/**
 * Deterministically validate a Hermes EditorialDecision against project evidence and constraints.
 */
export function validateEditorialDecision(
  decision: EditorialDecision,
  knownEvidenceIds: Iterable<string>,
): DecisionValidationIssue[] {
  const issues: DecisionValidationIssue[] = []
  const known = new Set(knownEvidenceIds)

  if (decision.targetRange.endSec < decision.targetRange.startSec || decision.targetRange.startSec < 0) {
    issues.push({
      code: 'INVALID_RANGE',
      decisionId: decision.id,
      message: `Decision target range [${decision.targetRange.startSec}, ${decision.targetRange.endSec}] is invalid.`,
    })
  }

  if (!decision.rationale || !decision.rationale.trim()) {
    issues.push({
      code: 'MISSING_RATIONALE',
      decisionId: decision.id,
      message: `Decision ${decision.id} is missing a required editorial rationale.`,
    })
  }

  for (const ref of decision.evidenceRefs) {
    if (!known.has(ref)) {
      issues.push({
        code: 'UNKNOWN_EVIDENCE',
        decisionId: decision.id,
        message: `Evidence ref '${ref}' is not recognized in current project evidence.`,
      })
    }
  }

  return issues
}

/**
 * Validate a list of Hermes EditorialDecisions.
 */
export function validateEditorialDecisionList(
  decisions: EditorialDecision[],
  knownEvidenceIds: Iterable<string>,
): DecisionValidationIssue[] {
  return decisions.flatMap((d) => validateEditorialDecision(d, knownEvidenceIds))
}

/**
 * TEST / BENCHMARK FIXTURE ONLY:
 *
 * Deterministic decision fixture generator used to validate downstream EditPlan
 * synthesis and execution pipelines when running in headless test environments
 * without an active Hermes LLM turn.
 *
 * Production editorial decisions are made exclusively by Hermes.
 */
export function buildEditorialDecisionFixture(bundle: EditorialEvidenceBundle): EditorialDecision[] {
  const decisions: EditorialDecision[] = []
  const fps = bundle.timelineSummary.fps || 30

  // 1. Multimodal Conflict & Pause Judgement Fixture
  for (const audioSeg of bundle.audioEvidence.segments) {
    if (audioSeg.speechActivity === 'breath' || audioSeg.breathDetected) {
      decisions.push({
        id: `dec-breath-${audioSeg.startSec.toFixed(2)}`,
        decisionKind: 'PRESERVE_BREATH',
        targetRange: {
          startSec: audioSeg.startSec,
          endSec: audioSeg.endSec,
          startFrame: Math.round(audioSeg.startSec * fps),
          endFrame: Math.round(audioSeg.endSec * fps),
        },
        intent: 'Preserve natural pre-speech breath to maintain acoustic authenticity',
        actionPolicy: 'EXECUTE',
        evidenceRefs: [`evidence-audio-${audioSeg.mediaId}`],
        knowledgeRefs: ['audio.breaths-and-room-tone'],
        confidence: 0.95,
        rationale: 'Audio analysis observed genuine inhalation; cutting through breath would cause unnatural abrupt attack.',
      })
    }
  }

  // 2. Audio Boundary Seam Smoothing Fixture
  for (const boundary of bundle.audioEvidence.boundaryInspections) {
    if (boundary.recommendedRepair.action !== 'NONE') {
      decisions.push({
        id: `dec-boundary-${boundary.outgoingTimeSec.toFixed(2)}`,
        decisionKind: 'SMOOTH_AUDIO_SEAM',
        targetRange: {
          startSec: boundary.outgoingTimeSec,
          endSec: Number((boundary.outgoingTimeSec + 0.1).toFixed(2)),
          startFrame: Math.round(boundary.outgoingTimeSec * fps),
          endFrame: Math.round((boundary.outgoingTimeSec + 0.1) * fps),
        },
        intent: 'Smooth audio transition across edit boundary',
        actionPolicy: 'EXECUTE',
        evidenceRefs: [`evidence-boundary-${boundary.outgoingMediaId}`],
        knowledgeRefs: ['audio.dialogue-seams'],
        confidence: 0.92,
        rationale: boundary.recommendedRepair.rationale,
      })
    }
  }

  // 3. B-Roll Insertion or Missing Asset Fallback Fixture
  if (bundle.visualEvidence.brollEvaluation) {
    const evalResult = bundle.visualEvidence.brollEvaluation
    if (evalResult.tier === 'CLEAR_MATCH' && evalResult.topCandidate) {
      const top = evalResult.topCandidate
      decisions.push({
        id: `dec-broll-${top.segmentId}`,
        decisionKind: 'ADD_BROLL',
        targetRange: {
          startSec: evalResult.intent.targetDialogueRange.startSec,
          endSec: evalResult.intent.targetDialogueRange.endSec,
          startFrame: Math.round(evalResult.intent.targetDialogueRange.startSec * fps),
          endFrame: Math.round(evalResult.intent.targetDialogueRange.endSec * fps),
        },
        intent: `Illustrate dialogue with relevant B-roll depicting "${evalResult.intent.concept}"`,
        actionPolicy: 'PROPOSE',
        evidenceRefs: [`evidence-vis-seg:${top.mediaId}:${top.segmentId}`],
        knowledgeRefs: ['broll.motivation-and-placement'],
        confidence: top.compositeScore,
        rationale: `Found stable, highly relevant candidate (score: ${top.compositeScore}) with refined sub-clip bounds.`,
        recommendedOperations: [
          {
            executor: 'video_add_clip',
            summary: `Insert ${top.refinedRange.durationSec}s B-roll overlay on Track 2`,
            risk: 'reversible',
            args: {
              media_id: top.mediaId,
              track_id: 'track-video-overlay-2',
              from_frame: Math.round(evalResult.intent.targetDialogueRange.startSec * fps),
              duration_frames: Math.round(top.refinedRange.durationSec * fps),
              source_start_frame: top.refinedRange.sourceStartFrame,
            },
          },
        ],
      })
    } else if (evalResult.tier === 'NO_MATCH') {
      decisions.push({
        id: `dec-broll-missing-${evalResult.intent.concept.slice(0, 16)}`,
        decisionKind: 'REQUEST_ASSET',
        targetRange: {
          startSec: evalResult.intent.targetDialogueRange.startSec,
          endSec: evalResult.intent.targetDialogueRange.endSec,
        },
        intent: `Request user asset for "${evalResult.intent.concept}"`,
        actionPolicy: 'ASK_USER',
        evidenceRefs: [],
        knowledgeRefs: ['broll.motivation-and-placement'],
        confidence: 0.90,
        rationale: `No suitable B-roll footage was found in the library for "${evalResult.intent.concept}". User prompted to import or keep A-roll.`,
      })
    }
  }

  // 4. Dialogue + Music Dynamic Ducking Fixture
  if (bundle.musicEvidence?.dialogueRelationship) {
    const rel = bundle.musicEvidence.dialogueRelationship
    decisions.push({
      id: `dec-ducking-${rel.dialogueRange.startSec.toFixed(2)}`,
      decisionKind: 'DUCK_MUSIC',
      targetRange: {
        startSec: rel.dialogueRange.startSec,
        endSec: rel.dialogueRange.endSec,
      },
      intent: 'Apply dynamic sidechain ducking to background music during dialogue',
      actionPolicy: 'EXECUTE',
      evidenceRefs: [`evidence-music-${rel.musicMediaId}`],
      knowledgeRefs: ['music.dialogue-relationship'],
      confidence: 0.94,
      rationale: rel.recommendedDucking.rationale,
      recommendedOperations: [
        {
          executor: 'video_update_item',
          summary: `Set sidechain ducking (${rel.recommendedDucking.duckDb}dB) on dialogue item`,
          risk: 'reversible',
          args: {
            item_id: 'item-dialogue-lead',
            updates: {
              audioDucking: {
                duckOthersDb: rel.recommendedDucking.duckDb,
                attackSec: rel.recommendedDucking.attackSec,
                releaseSec: rel.recommendedDucking.releaseSec,
              },
            },
          },
        },
      ],
    })
  }

  // 5. Clean Section No-Op Fixture
  if (decisions.length === 0) {
    decisions.push({
      id: 'dec-noop-clean-section',
      decisionKind: 'NO_OP_CLEAN_SECTION',
      targetRange: { startSec: 0, endSec: bundle.timelineSummary.durationSec },
      intent: 'Preserve clean, well-paced section without adding unnecessary edits',
      actionPolicy: 'SKIP',
      evidenceRefs: [],
      knowledgeRefs: ['universal.economy-of-means'],
      confidence: 0.98,
      rationale: 'All dialogue, audio boundaries, visual framing, and music energy are well-balanced; economy of means dictates zero edits.',
    })
  }

  return decisions
}
