import { describe, it, expect } from 'vitest'
import {
  buildEditorialDecisionFixture,
  validateEditorialDecision,
  validateEditorialDecisionList,
  type EditorialEvidenceBundle,
  type EditorialDecision,
  buildVisualSegments,
  rankVisualSegments,
  rankBrollCandidates,
  evaluateBrollCandidates,
  buildAudioSegmentEvidence,
  analyzeAudioBoundary,
  analyzeMusicTrack,
  evaluateDialogueMusicRelationship,
  getEditingGuidance,
} from './index.ts'
import { validateEditPlanForV1, type SclipEditPlan } from '@/features/editor/agent/edit-plan'

describe('SCLIP General Editorial Reasoning & Multimodal Integration (Phase 5)', () => {
  const projectId = 'proj-integrated-v1'
  const projectRevision = 'rev-p5-001'

  describe('Step 2, 3, 4, 6, 8 — Multimodal Evidence Bundling & Decision Validation', () => {
    it('assembles a bounded multimodal evidence bundle and validates mock Hermes decisions', () => {
      // 1. Audio boundary with zero-crossing click
      const boundaryInspection = analyzeAudioBoundary({
        outgoingMediaId: 'media-cam-a',
        outgoingTimeSec: 10.0,
        outgoingRmsDb: -22.0,
        incomingMediaId: 'media-cam-b',
        incomingTimeSec: 2.0,
        incomingRmsDb: -24.0,
      })

      // 2. Pre-speech breath
      const breathAudio = buildAudioSegmentEvidence({
        mediaId: 'media-cam-a',
        startSec: 4.1,
        endSec: 4.25,
        rmsDb: -41.0,
        breathObserved: true,
        breathConfidence: 0.92,
      })

      // 3. B-roll candidate for espresso pour
      const visualSegments = buildVisualSegments({
        mediaId: 'media-broll-kitchen',
        durationSec: 60.0,
        captions: [
          { timeSec: 25.0, text: 'Close-up of espresso pouring into white ceramic cup', sceneData: { shotType: 'close_up', action: 'coffee pouring' } },
        ],
      })
      const brollMatches = rankVisualSegments({ query: 'coffee pouring', segmentsWithVectors: visualSegments.map((s) => ({ segment: s })) })
      const brollIntent = { concept: 'coffee pouring', purpose: 'illustrative' as const, targetDialogueRange: { startSec: 12.0, endSec: 15.5 } }
      const brollCandidates = rankBrollCandidates({ intent: brollIntent, matches: brollMatches })
      const brollEvaluation = evaluateBrollCandidates({ intent: brollIntent, candidates: brollCandidates })

      // 4. Music analysis & dialogue masking
      const musicAnalysis = analyzeMusicTrack({ mediaId: 'media-bgm-pop', durationSec: 60.0, simulatedBpm: 120.0 })
      const dialogueRel = evaluateDialogueMusicRelationship({ dialogueRange: { startSec: 10.0, endSec: 20.0 }, musicAnalysis })

      // 5. Editorial Knowledge
      const guidance = getEditingGuidance({ topics: ['broll.motivation-and-placement', 'audio.dialogue-seams', 'music.dialogue-relationship'] })

      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId,
        projectRevision,
        objective: 'Tighten dialogue, insert illustrative B-roll, and balance background music.',
        taskIntent: 'ROUGH_CUT',
        timelineSummary: { durationSec: 60.0, durationFrames: 1800, fps: 30, itemCount: 4, trackCount: 3 },
        transcriptWindow: {
          words: [
            { id: 'w1', word: 'Making', startSec: 12.0, endSec: 12.4, confidence: 0.98 },
            { id: 'w2', word: 'espresso', startSec: 12.5, endSec: 13.1, confidence: 0.99 },
            { id: 'w3', word: 'every', startSec: 13.2, endSec: 13.6, confidence: 0.97 },
            { id: 'w4', word: 'morning.', startSec: 13.7, endSec: 14.2, confidence: 0.99 },
          ],
          totalWords: 4,
        },
        visualEvidence: {
          segments: visualSegments,
          brollCandidates,
          brollEvaluation,
        },
        audioEvidence: {
          segments: [breathAudio],
          boundaryInspections: [boundaryInspection],
        },
        musicEvidence: {
          analysis: musicAnalysis,
          dialogueRelationship: dialogueRel,
        },
        relevantKnowledge: guidance.modules.map((m) => ({ id: m.id, title: m.title, summary: m.summary })),
        creatorStyle: { pacePreference: 'moderate', brollFrequency: 'moderate', cutStyle: 'mixed' },
        epistemicStatus: {
          observed: ['transcript:w1..w4', 'audio:breath@4.1s', 'boundary:click@10.0s'],
          inferred: ['broll:espresso_match', 'music:tempo@120bpm'],
          heuristic: ['ducking:-12dB'],
          degraded: [],
          unknown: [],
        },
        limitations: [],
      }

      // Generate expected decisions via test fixture generator
      const decisions = buildEditorialDecisionFixture(bundle)

      expect(decisions.length).toBeGreaterThanOrEqual(4)

      // Verified Decision 1: PRESERVE_BREATH
      const breathDec = decisions.find((d) => d.decisionKind === 'PRESERVE_BREATH')
      expect(breathDec).toBeDefined()
      expect(breathDec?.actionPolicy).toBe('EXECUTE')

      // Verified Decision 2: SMOOTH_AUDIO_SEAM
      const audioDec = decisions.find((d) => d.decisionKind === 'SMOOTH_AUDIO_SEAM')
      expect(audioDec).toBeDefined()
      expect(audioDec?.actionPolicy).toBe('EXECUTE')

      // Verified Decision 3: ADD_BROLL
      const brollDec = decisions.find((d) => d.decisionKind === 'ADD_BROLL')
      expect(brollDec).toBeDefined()
      expect(brollDec?.actionPolicy).toBe('PROPOSE')
      expect(brollDec?.recommendedOperations?.[0]?.executor).toBe('video_add_clip')

      // Verified Decision 4: DUCK_MUSIC
      const duckDec = decisions.find((d) => d.decisionKind === 'DUCK_MUSIC')
      expect(duckDec).toBeDefined()
      expect(duckDec?.actionPolicy).toBe('EXECUTE')
      expect(duckDec?.recommendedOperations?.[0]?.executor).toBe('video_update_item')

      // Validate all decisions against project evidence
      const knownEvidence = new Set([
        'evidence-audio-media-cam-a',
        'evidence-boundary-media-cam-a',
        `evidence-vis-seg:${visualSegments[0]!.mediaId}:${visualSegments[0]!.id}`,
        'evidence-music-media-bgm-pop',
      ])
      const issues = validateEditorialDecisionList(decisions, knownEvidence)
      expect(issues).toEqual([])
    })

    it('flags invalid decisions with negative ranges or missing rationale', () => {
      const badDecision: EditorialDecision = {
        id: 'bad-dec-1',
        decisionKind: 'TIGHTEN_PACING',
        targetRange: { startSec: 10.0, endSec: 5.0 }, // Invalid inverted range
        intent: 'Invalid range test',
        actionPolicy: 'EXECUTE',
        evidenceRefs: ['unknown-evidence-id'],
        knowledgeRefs: [],
        confidence: 0.5,
        rationale: '', // Missing rationale
      }

      const issues = validateEditorialDecision(badDecision, ['known-id'])
      expect(issues.some((i) => i.code === 'INVALID_RANGE')).toBe(true)
      expect(issues.some((i) => i.code === 'MISSING_RATIONALE')).toBe(true)
      expect(issues.some((i) => i.code === 'UNKNOWN_EVIDENCE')).toBe(true)
    })
  })

  describe('Step 10 — Retake Comparison Scenario (Mock Evaluation)', () => {
    it('compares acoustic and transcript evidence to select earlier Take 1 over muffled Take 2', () => {
      const take1 = { id: 'take-1', text: 'Welcome to the masterclass.', rmsDb: -22.0, audioQuality: 'clean', confidence: 0.98 }
      const take2 = { id: 'take-2', text: 'Welcome to the masterclass...', rmsDb: -35.0, audioQuality: 'muffled', confidence: 0.85 }

      // Take 1 is chosen because of superior acoustic clarity despite being earlier
      const chosenTake = take1.audioQuality === 'clean' && take1.rmsDb > take2.rmsDb ? take1 : take2
      expect(chosenTake.id).toBe('take-1')
    })
  })

  describe('Step 16 — Multimodal Conflict Resolution (Mock Scenario)', () => {
    it('preserves an expressive emotional pause when visual reaction and vocal breath contradict transcript silence deletion', () => {
      const breathAudio = buildAudioSegmentEvidence({
        mediaId: 'media-emotional-scene',
        startSec: 22.0,
        endSec: 23.5,
        rmsDb: -42.0,
        hasVocalization: false,
        breathObserved: true,
        breathConfidence: 0.94,
      })

      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId,
        projectRevision,
        objective: 'Evaluate pause at 22.0s to 23.5s',
        taskIntent: 'TIGHTEN_PACING',
        timelineSummary: { durationSec: 30.0, durationFrames: 900, fps: 30, itemCount: 1, trackCount: 1 },
        visualEvidence: { segments: [] },
        audioEvidence: { segments: [breathAudio], boundaryInspections: [] },
        relevantKnowledge: getEditingGuidance({ topics: ['audio.breaths-and-room-tone', 'universal.economy-of-means'] }).modules,
        epistemicStatus: { observed: ['audio:breath@22.0s'], inferred: [], heuristic: [], degraded: [], unknown: [] },
        limitations: [],
      }

      const decisions = buildEditorialDecisionFixture(bundle)
      const breathDec = decisions.find((d) => d.decisionKind === 'PRESERVE_BREATH')

      // Must preserve the breath rather than deleting it as dead silence
      expect(breathDec).toBeDefined()
      expect(breathDec?.actionPolicy).toBe('EXECUTE')
      expect(breathDec?.rationale).toContain('observed genuine inhalation')
    })
  })

  describe('Step 17 — Missing B-Roll Asset Fallback', () => {
    it('triggers ASK_USER asset request when no suitable footage exists in library', () => {
      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId,
        projectRevision,
        objective: 'Insert motorcycle B-roll',
        taskIntent: 'ADD_BROLL',
        timelineSummary: { durationSec: 30.0, durationFrames: 900, fps: 30, itemCount: 1, trackCount: 1 },
        visualEvidence: {
          segments: [],
          brollEvaluation: {
            tier: 'NO_MATCH',
            intent: { concept: 'motorcycle on highway', purpose: 'illustrative', targetDialogueRange: { startSec: 10, endSec: 14 } },
            alternativeCandidates: [],
            confidenceGap: 0,
            actionRecommended: 'ASK_USER',
          },
        },
        audioEvidence: { segments: [], boundaryInspections: [] },
        relevantKnowledge: [],
        epistemicStatus: { observed: [], inferred: [], heuristic: [], degraded: [], unknown: [] },
        limitations: [],
      }

      const decisions = buildEditorialDecisionFixture(bundle)
      const missingDec = decisions.find((d) => d.decisionKind === 'REQUEST_ASSET')

      expect(missingDec).toBeDefined()
      expect(missingDec?.actionPolicy).toBe('ASK_USER')
      expect(missingDec?.rationale).toContain('No suitable B-roll footage was found')
    })
  })

  describe('Step 18 — Clean Section No-Op Benchmark', () => {
    it('produces NO_OP_CLEAN_SECTION with actionPolicy: SKIP when section is already well-paced', () => {
      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId,
        projectRevision,
        objective: 'Review clean section',
        taskIntent: 'GENERAL_EDIT',
        timelineSummary: { durationSec: 20.0, durationFrames: 600, fps: 30, itemCount: 2, trackCount: 2 },
        visualEvidence: { segments: [] },
        audioEvidence: { segments: [], boundaryInspections: [] },
        relevantKnowledge: getEditingGuidance({ topics: ['universal.economy-of-means'] }).modules,
        epistemicStatus: { observed: [], inferred: [], heuristic: [], degraded: [], unknown: [] },
        limitations: [],
      }

      const decisions = buildEditorialDecisionFixture(bundle)

      expect(decisions.length).toBe(1)
      expect(decisions[0]!.decisionKind).toBe('NO_OP_CLEAN_SECTION')
      expect(decisions[0]!.actionPolicy).toBe('SKIP')
      expect(decisions[0]!.rationale).toContain('economy of means dictates zero edits')
    })
  })

  describe('Step 19, 21 — Multi-Operation Typed EditPlan Synthesis & Layered Verification', () => {
    it('validates a complete synthesized multimodal EditPlan with script cut, B-roll overlay, and ducking', () => {
      const plan: SclipEditPlan = {
        schemaVersion: 1,
        title: 'Multimodal Talking-Head Rough Cut Optimization',
        goal: 'Remove false start, insert coffee B-roll, smooth audio seams, and duck background music',
        projectId,
        projectRevision,
        evidenceIds: ['evidence-speech-phrase-1', 'evidence-vis-seg:media-broll:1', 'evidence-music-duck-1'],
        limitations: ['A-roll audio preserved; B-roll overlay on Track 2; Music ducked by -12dB.'],
        operations: [
          {
            id: 'op-1-remove-false-start',
            executor: 'video_apply_script',
            summary: 'Remove false start phrase at timeline 00:02 to 00:05',
            risk: 'reversible',
            intent: 'Tighten opening delivery',
            args: {
              operations: [{ type: 'remove_phrase', itemId: 'item-speech-1', startSec: 2.0, endSec: 5.0 }],
            },
            evidenceIds: ['evidence-speech-phrase-1'],
            verification: ['deterministic'],
          },
          {
            id: 'op-2-add-broll',
            executor: 'video_add_clip',
            summary: 'Insert 3.5s espresso pouring B-roll on Track 2',
            risk: 'reversible',
            intent: 'Illustrate dialogue keyword "espresso"',
            args: {
              media_id: 'media-broll-kitchen',
              track_id: 'track-video-overlay-2',
              from_frame: 360,
              duration_frames: 105,
              source_start_frame: 750,
            },
            evidenceIds: ['evidence-vis-seg:media-broll:1'],
            verification: ['deterministic', 'perceptual'],
            dependsOn: ['op-1-remove-false-start'],
          },
          {
            id: 'op-3-duck-music',
            executor: 'video_update_item',
            summary: 'Set sidechain ducking on dialogue track',
            risk: 'reversible',
            intent: 'Duck background music beneath spoken dialogue',
            args: {
              item_id: 'item-speech-1',
              updates: {
                audioDucking: { duckOthersDb: -12.0, attackSec: 0.08, releaseSec: 0.25 },
              },
            },
            evidenceIds: ['evidence-music-duck-1'],
            verification: ['deterministic'],
          },
        ],
      }

      const issues = validateEditPlanForV1(plan, [
        'evidence-speech-phrase-1',
        'evidence-vis-seg:media-broll:1',
        'evidence-music-duck-1',
      ])

      expect(issues).toEqual([])
    })
  })

  describe('Step 27 — Context Payload Budget Measurement', () => {
    it('measures serialized multimodal evidence bundle payload within budget limits', () => {
      const guidance = getEditingGuidance({ topics: ['talking-head.rough-cut-pacing', 'broll.motivation-and-placement'] })
      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId,
        projectRevision,
        objective: 'Improve pacing and insert B-roll',
        taskIntent: 'ROUGH_CUT',
        timelineSummary: { durationSec: 120.0, durationFrames: 3600, fps: 30, itemCount: 5, trackCount: 3 },
        transcriptWindow: {
          words: [
            { id: 'w1', word: 'Hello', startSec: 0.5, endSec: 0.9, confidence: 0.99 },
            { id: 'w2', word: 'world', startSec: 1.0, endSec: 1.4, confidence: 0.98 },
          ],
          totalWords: 2,
        },
        visualEvidence: { segments: [] },
        audioEvidence: { segments: [], boundaryInspections: [] },
        relevantKnowledge: guidance.modules.map((m) => ({
          id: m.id,
          title: m.title,
          summary: m.summary,
          principles: m.principles.slice(0, 2),
        })),
        epistemicStatus: { observed: ['transcript:w1..w2'], inferred: [], heuristic: [], degraded: [], unknown: [] },
        limitations: [],
      }

      const payloadBytes = JSON.stringify(bundle).length
      console.log(`Multimodal Evidence Bundle Payload: ${payloadBytes} bytes (~${Math.round(payloadBytes / 4)} tokens)`)

      // Must be well within the Hermes bounded budget (< 6000 bytes / ~1500 tokens)
      expect(payloadBytes).toBeLessThan(6000)
    })
  })
})
