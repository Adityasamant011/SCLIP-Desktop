import { describe, it, expect } from 'vitest'
import {
  buildVisualSegments,
  rankVisualSegments,
  rankBrollCandidates,
  evaluateBrollCandidates,
  refineBrollSubRange,
  computeBrollCropTransform,
  type BrollIntent,
  type RawMediaCaptionInput,
} from './index.ts'
import { validateEditPlanForV1, type SclipEditPlan } from '@/features/editor/agent/edit-plan'

describe('SCLIP B-Roll Intelligence V1 (Phase 2C)', () => {
  const mediaId = 'media-kitchen-broll-120s'
  const captions: RawMediaCaptionInput[] = [
    {
      timeSec: 10.0,
      text: 'Host speaking directly to camera in studio',
      sceneData: { shotType: 'medium', subjects: ['host'], action: 'talking' },
    },
    {
      timeSec: 35.0,
      text: 'Extremely shaky footage of kitchen floor and camera repositioning',
      sceneData: { shotType: 'wide', action: 'shaky camera movement' },
    },
    {
      timeSec: 75.0, // 01:15
      text: 'Extreme close-up of dark espresso pouring smoothly into white ceramic cup',
      sceneData: { shotType: 'extreme_close_up', subjects: ['espresso', 'cup'], action: 'coffee pouring into cup' },
    },
    {
      timeSec: 85.0, // Alternative close-up shot
      text: 'Close-up of coffee beans falling into hopper',
      sceneData: { shotType: 'close_up', subjects: ['coffee beans', 'grinder'], action: 'beans dropping' },
    },
    {
      timeSec: 110.0,
      text: 'Wide shot of empty kitchen studio',
      sceneData: { shotType: 'wide', setting: 'kitchen' },
    },
  ]

  const segments = buildVisualSegments({
    mediaId,
    durationSec: 120.0,
    fps: 30,
    captions,
  })

  describe('Step 6 — Sub-Range Refinement', () => {
    it('refines a 30s coarse segment down to a tight 3.5s action sub-clip centered on the visual moment', () => {
      const pouringSegment = segments[2]! // Sample at 75s (bounds 55s–80s)
      expect(pouringSegment.durationSec).toBe(25)

      const refined = refineBrollSubRange({
        segment: pouringSegment,
        desiredDurationSec: 3.5,
        fps: 30,
        momentCenterSec: 75.0,
      })

      expect(refined.durationSec).toBe(3.5)
      expect(refined.sourceStartSec).toBe(73.25)
      expect(refined.sourceEndSec).toBe(76.75)
      expect(refined.sourceStartFrame).toBe(Math.round(73.25 * 30))
      expect(refined.sourceEndFrame).toBe(Math.round(76.75 * 30))
    })
  })

  describe('Step 4, 19 — Candidate Ranking & Quality/Stability Penalty', () => {
    it('ranks stable usable clip above shaky clip even if both match query', () => {
      const intent: BrollIntent = {
        concept: 'kitchen action and coffee preparation',
        purpose: 'illustrative',
        targetDialogueRange: { startSec: 12.0, endSec: 15.5 },
        desiredDurationSec: 3.5,
        desiredShotType: 'extreme_close_up',
      }

      // Create two matches: one stable pouring shot, one shaky repositioning shot
      const matches = rankVisualSegments({
        query: 'kitchen coffee preparation',
        segmentsWithVectors: [
          { segment: segments[1]! }, // Shaky segment
          { segment: segments[2]! }, // Stable pouring segment
        ],
      })

      const candidates = rankBrollCandidates({
        intent,
        matches,
        fps: 30,
      })

      expect(candidates.length).toBe(2)
      // Top candidate must be the stable pouring shot (segment 2), NOT the shaky shot (segment 1)
      expect(candidates[0]!.segmentId).toBe(segments[2]!.id)
      expect(candidates[0]!.isUsable).toBe(true)
      expect(candidates[0]!.stabilityScore).toBeGreaterThanOrEqual(0.85)

      // Shaky candidate was penalized
      expect(candidates[1]!.segmentId).toBe(segments[1]!.id)
      expect(candidates[1]!.compositeScore).toBeLessThan(candidates[0]!.compositeScore)
    })
  })

  describe('Step 5, 11, 12, 13, 17 — Match Policy, Missing B-Roll Fallback & Ask User', () => {
    it('CLEAR_MATCH: identifies dominant candidate for "espresso pouring into cup"', () => {
      const intent: BrollIntent = {
        concept: 'coffee pouring into cup',
        purpose: 'illustrative',
        targetDialogueRange: { startSec: 10.0, endSec: 13.5 },
        desiredDurationSec: 3.5,
      }

      const queryVector = new Float32Array(512).fill(0.01)
      queryVector[10] = 0.5
      queryVector[20] = 0.4

      const segmentsWithVectors = segments.map((seg, idx) => {
        const vec = new Float32Array(512).fill(0.01)
        if (idx === 2) {
          vec[10] = 0.48
          vec[20] = 0.38
        }
        return { segment: seg, imageVector: vec }
      })

      const matches = rankVisualSegments({
        query: 'coffee pouring into cup',
        queryVector,
        segmentsWithVectors,
      })

      const candidates = rankBrollCandidates({ intent, matches })
      const evaluation = evaluateBrollCandidates({ intent, candidates })

      expect(evaluation.tier).toBe('CLEAR_MATCH')
      expect(evaluation.topCandidate).toBeDefined()
      expect(evaluation.topCandidate?.segmentId).toBe(segments[2]!.id)
      expect(evaluation.confidenceGap).toBeGreaterThan(0.05)
      expect(evaluation.actionRecommended).toBe('PROPOSE')
    })

    it('NO_MATCH (Negative Query): prompts user with structured BrollAssetRequest when footage is missing', () => {
      const intent: BrollIntent = {
        concept: 'motorcycle speeding on highway asphalt',
        purpose: 'illustrative',
        targetDialogueRange: { startSec: 20.0, endSec: 24.0 },
        desiredDurationSec: 4.0,
      }

      const motorcycleVector = new Float32Array(512).fill(-0.02)
      motorcycleVector[100] = 0.6

      const segmentsWithVectors = segments.map((seg) => ({
        segment: seg,
        imageVector: new Float32Array(512).fill(0.01),
      }))

      const matches = rankVisualSegments({
        query: 'motorcycle speeding on highway asphalt',
        queryVector: motorcycleVector,
        segmentsWithVectors,
      })

      const candidates = rankBrollCandidates({ intent, matches })
      const evaluation = evaluateBrollCandidates({ intent, candidates })

      // Must be classified as NO_MATCH and trigger ASK_USER
      expect(evaluation.tier).toBe('NO_MATCH')
      expect(evaluation.actionRecommended).toBe('ASK_USER')
      expect(evaluation.assetRequest).toBeDefined()
      expect(evaluation.assetRequest?.concept).toBe('motorcycle speeding on highway asphalt')
      expect(evaluation.assetRequest?.actionOptions).toContain('import_asset')
      expect(evaluation.assetRequest?.actionOptions).toContain('keep_a_roll')
    })

    it('AMBIGUOUS_MATCHES: provides top candidates and alternatives when two shots match closely', () => {
      const intent: BrollIntent = {
        concept: 'coffee preparation in kitchen',
        purpose: 'illustrative',
        targetDialogueRange: { startSec: 5.0, endSec: 8.5 },
        desiredDurationSec: 3.5,
      }

      // Both segment 2 (pouring) and segment 3 (beans falling) match 'coffee'
      const matches = rankVisualSegments({
        query: 'coffee preparation',
        segmentsWithVectors: [
          { segment: segments[2]! },
          { segment: segments[3]! },
        ],
      })

      const candidates = rankBrollCandidates({ intent, matches })
      const evaluation = evaluateBrollCandidates({ intent, candidates })

      expect(evaluation.tier).toBe('AMBIGUOUS_MATCHES')
      expect(evaluation.topCandidate).toBeDefined()
      expect(evaluation.alternativeCandidates.length).toBeGreaterThan(0)
      expect(evaluation.actionRecommended).toBe('PROPOSE')
    })
  })

  describe('Step 9, 20 — Aspect Ratio Crop / Reframe Transform', () => {
    it('computes safe center-crop for 16:9 landscape source in 9:16 portrait canvas without stretching', () => {
      const result = computeBrollCropTransform({
        sourceWidth: 1920,
        sourceHeight: 1080,
        canvasWidth: 1080,
        canvasHeight: 1920,
      })

      expect(result.scale).toBeCloseTo(1.777, 2)
      expect(result.crop.height).toBe(1080)
      expect(result.crop.width).toBe(608) // 1080 * (1080 / 1920) = 607.5
      expect(result.crop.x).toBe(656)     // (1920 - 608) / 2 = 656
      expect(result.crop.y).toBe(0)
      expect(result.isDegradedCenterCrop).toBe(true)
    })

    it('computes identity transform for matching 16:9 source in 16:9 canvas', () => {
      const result = computeBrollCropTransform({
        sourceWidth: 1920,
        sourceHeight: 1080,
        canvasWidth: 1920,
        canvasHeight: 1080,
      })

      expect(result.scale).toBe(1.0)
      expect(result.crop.x).toBe(0)
      expect(result.crop.y).toBe(0)
      expect(result.crop.width).toBe(1920)
      expect(result.crop.height).toBe(1080)
      expect(result.isDegradedCenterCrop).toBe(false)
    })
  })

  describe('Step 10, 13, 14, 15 — Typed EditPlan Integration for B-Roll Insertion', () => {
    it('validates a structured EditPlan placing refined B-roll over target dialogue range', () => {
      const plan: SclipEditPlan = {
        schemaVersion: 1,
        title: 'Insert Illustrative Coffee Pour B-Roll',
        goal: 'Cover spoken dialogue mentioning espresso with a refined close-up B-roll shot',
        projectId: 'project-coffee-1',
        projectRevision: 'rev-abc12345',
        evidenceIds: ['evidence-vis-seg:media-kitchen-broll-120s:2', 'evidence-word-espresso-14'],
        limitations: ['B-roll placed with safe center-crop; A-roll audio preserved on track 1.'],
        operations: [
          {
            id: 'op-broll-1',
            executor: 'video_add_clip',
            summary: 'Insert 3.5s espresso pouring B-roll on Track 2 (Overlay)',
            risk: 'reversible',
            intent: 'Illustrate the spoken word "espresso" with a stable extreme close-up pour',
            args: {
              media_id: mediaId,
              track_id: 'track-video-overlay-2',
              from_frame: 300,        // Timeline 10.0s @ 30fps
              duration_frames: 105,   // 3.5s @ 30fps
              source_start_frame: 2198, // Source 73.25s @ 30fps
            },
            evidenceIds: ['evidence-vis-seg:media-kitchen-broll-120s:2'],
            verification: ['deterministic', 'perceptual'],
          },
        ],
      }

      const issues = validateEditPlanForV1(plan, [
        'evidence-vis-seg:media-kitchen-broll-120s:2',
        'evidence-word-espresso-14',
      ])

      expect(issues).toEqual([])
    })
  })
})
