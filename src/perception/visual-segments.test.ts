import { describe, it, expect } from 'vitest'
import {
  buildVisualSegments,
  cosineSimilarity,
  rankVisualSegments,
  type RawMediaCaptionInput,
  type VisualSegment,
} from './index.ts'

describe('SCLIP Visual Segment Intelligence (Phase 2B)', () => {
  // Realistic 2-minute kitchen B-roll source asset fixture
  const kitchenMediaId = 'media-kitchen-raw-120s'
  const kitchenDurationSec = 120.0
  const kitchenFps = 30

  // 5 distinct visual moments sampled during video analysis
  const kitchenCaptions: RawMediaCaptionInput[] = [
    {
      timeSec: 8.0,
      text: 'A person speaking to the camera in a kitchen',
      sceneData: {
        shotType: 'medium',
        subjects: ['person', 'host'],
        action: 'talking to camera',
        setting: 'kitchen studio',
        lighting: 'soft daylight',
      },
      palette: ['#2b2b2b', '#d4a373'],
      thumbRelPath: 'thumbs/kitchen_0.webp',
    },
    {
      timeSec: 22.0,
      text: 'Shaky camera repositioning and adjusting focus',
      sceneData: {
        shotType: 'wide',
        action: 'camera shake and repositioning',
        setting: 'kitchen',
      },
      palette: ['#1a1a1a', '#555555'],
      thumbRelPath: 'thumbs/kitchen_1.webp',
    },
    {
      timeSec: 45.0,
      text: 'Close-up of polished chrome espresso machine',
      sceneData: {
        shotType: 'close_up',
        subjects: ['espresso machine', 'portafilter'],
        action: 'machine heating up',
        setting: 'countertop',
      },
      palette: ['# silver', '#black'],
      thumbRelPath: 'thumbs/kitchen_2.webp',
    },
    {
      timeSec: 75.0, // 01:15
      text: 'Close-up shot of rich dark coffee pouring into a ceramic cup',
      sceneData: {
        shotType: 'extreme_close_up',
        subjects: ['espresso', 'cup', 'coffee stream'],
        action: 'coffee pouring into cup',
        setting: 'countertop',
        lighting: 'warm studio light',
      },
      palette: ['#3e2723', '#d7ccc8'],
      thumbRelPath: 'thumbs/kitchen_3.webp',
    },
    {
      timeSec: 105.0, // 01:45
      text: 'Wide shot of the host drinking coffee and smiling at the countertop',
      sceneData: {
        shotType: 'wide',
        subjects: ['person', 'host', 'mug'],
        action: 'drinking coffee',
        setting: 'open kitchen',
      },
      palette: ['#f5f5f5', '#4e342e'],
      thumbRelPath: 'thumbs/kitchen_4.webp',
    },
  ]

  describe('Step 2, 3, 4, 7, 8 — Segment Contract, Motion, Shot Type & Provenance', () => {
    it('generates truthful, time-indexed visual segments with valid bounds', () => {
      const segments = buildVisualSegments({
        mediaId: kitchenMediaId,
        durationSec: kitchenDurationSec,
        fps: kitchenFps,
        contentHash: 'hash-kitchen-abc123',
        captions: kitchenCaptions,
      })

      expect(segments.length).toBe(5)

      // Verify bounds cover timeline monotonically
      expect(segments[0]!.startSec).toBe(0)
      expect(segments[segments.length - 1]!.endSec).toBe(kitchenDurationSec)

      for (let i = 0; i < segments.length - 1; i++) {
        expect(segments[i]!.endSec).toBe(segments[i + 1]!.startSec)
        expect(segments[i]!.durationSec).toBeGreaterThan(0)
        expect(segments[i]!.sourceStartFrame).toBeLessThan(segments[i]!.sourceEndFrame)
      }

      // Verify shot classification
      expect(segments[0]!.sceneData?.shotType).toBe('medium')
      expect(segments[2]!.sceneData?.shotType).toBe('close_up')
      expect(segments[3]!.sceneData?.shotType).toBe('extreme_close_up')
      expect(segments[4]!.sceneData?.shotType).toBe('wide')

      // Verify motion / stability classification
      expect(segments[1]!.motionLevel).toBe('shaky')
      expect(segments[1]!.cameraMotion).toBe('shaky')
      expect(segments[1]!.quality.stabilityScore).toBeLessThan(0.5)

      expect(segments[3]!.motionLevel).toBe('static')
      expect(segments[3]!.quality.stabilityScore).toBeGreaterThanOrEqual(0.9)
      expect(segments[3]!.quality.isUsableForBroll).toBe(true)

      // Verify truthful provenance
      for (const seg of segments) {
        expect(seg.provenance.pixelsAnalyzed).toBe(true)
        expect(seg.provenance.semanticVisionPerformed).toBe(true)
        expect(seg.provenance.degraded).toBe(false)
        expect(seg.provenance.model).toBe('Xenova/clip-vit-base-patch32')
        expect(seg.provenance.sourceAssetFingerprint).toBe('sha256:hash-kitchen-abc123')
      }
    })

    it('produces explicit degraded provenance when no visual samples exist', () => {
      const emptySegments = buildVisualSegments({
        mediaId: 'media-unanalysed-mp4',
        durationSec: 60.0,
      })

      expect(emptySegments.length).toBe(1)
      expect(emptySegments[0]!.provenance.pixelsAnalyzed).toBe(false)
      expect(emptySegments[0]!.provenance.semanticVisionPerformed).toBe(false)
      expect(emptySegments[0]!.provenance.degraded).toBe(true)
      expect(emptySegments[0]!.provenance.degradedReason).toBe('NO_VISUAL_SAMPLES_CAPTURED')
    })
  })

  describe('Step 11, 12, 17, 19 — Critical Positive Sub-Clip Retrieval (Buried Moment)', () => {
    it('retrieves the exact sub-clip range (01:00–01:30) for "coffee pouring into cup" rather than whole file', () => {
      const segments = buildVisualSegments({
        mediaId: kitchenMediaId,
        durationSec: kitchenDurationSec,
        fps: kitchenFps,
        captions: kitchenCaptions,
      })

      // Simulate 512-dim normalized CLIP embedding vectors
      // Segment 3 (pouring coffee) has high alignment with coffee query vector
      const queryVector = new Float32Array(512).fill(0.02)
      queryVector[10] = 0.5
      queryVector[20] = 0.4

      const segmentsWithVectors = segments.map((seg, idx) => {
        const vec = new Float32Array(512).fill(0.01)
        if (idx === 3) {
          // Pouring espresso segment has high cosine alignment
          vec[10] = 0.48
          vec[20] = 0.38
        }
        return { segment: seg, imageVector: vec }
      })

      const query = 'coffee being poured into a cup'
      const matches = rankVisualSegments({
        query,
        queryVector,
        segmentsWithVectors,
        limit: 5,
      })

      expect(matches.length).toBeGreaterThan(0)

      const topMatch = matches[0]!
      expect(topMatch.mediaId).toBe(kitchenMediaId)
      expect(topMatch.segment.id).toBe(`vis-seg:${kitchenMediaId}:3`)

      // Exact sub-clip time bounds (spans around sample at 75s / 01:15)
      expect(topMatch.startSec).toBe(60.0) // 01:00
      expect(topMatch.endSec).toBe(90.0)   // 01:30
      expect(topMatch.durationSec).toBe(30.0)
      expect(topMatch.semanticScore).toBeGreaterThan(0.70)
      expect(topMatch.segment.quality.isUsableForBroll).toBe(true)

      // Verified exact action and description
      expect(topMatch.segment.sceneData?.action).toBe('coffee pouring into cup')
      expect(topMatch.segment.sceneData?.shotType).toBe('extreme_close_up')
    })
  })

  describe('Step 18 — Negative Query Test & Score Distribution', () => {
    it('returns low confidence / zero fake matches for concepts absent from the footage', () => {
      const segments = buildVisualSegments({
        mediaId: kitchenMediaId,
        durationSec: kitchenDurationSec,
        fps: kitchenFps,
        captions: kitchenCaptions,
      })

      // Query vector for motorcycle on highway has near-zero cosine with kitchen shots
      const motorcycleQueryVector = new Float32Array(512).fill(-0.02)
      motorcycleQueryVector[100] = 0.6

      const segmentsWithVectors = segments.map((seg) => ({
        segment: seg,
        imageVector: new Float32Array(512).fill(0.01),
      }))

      const query = 'motorcycle speeding on highway asphalt'
      const matches = rankVisualSegments({
        query,
        queryVector: motorcycleQueryVector,
        segmentsWithVectors,
        limit: 5,
      })

      // In a negative query, semanticScore should be very low (calibrated < 0.20)
      for (const m of matches) {
        expect(m.semanticScore).toBeLessThan(0.25)
        expect(m.keywordMatchScore).toBe(0)
      }
    })
  })

  describe('Step 21 — Search Payload Budget', () => {
    it('measures serialized visual segment search output size', () => {
      const segments = buildVisualSegments({
        mediaId: kitchenMediaId,
        durationSec: kitchenDurationSec,
        fps: kitchenFps,
        captions: kitchenCaptions,
      })

      const matches = rankVisualSegments({
        query: 'espresso machine',
        segmentsWithVectors: segments.map((s) => ({ segment: s })),
        limit: 3,
      })

      const payload = {
        success: true,
        projectId: 'test-proj',
        query: 'espresso machine',
        resultCount: matches.length,
        results: matches.map((m) => ({
          mediaId: m.mediaId,
          segmentId: m.segment.id,
          startSec: m.startSec,
          endSec: m.endSec,
          durationSec: m.durationSec,
          semanticScore: m.semanticScore,
          description: m.segment.description,
          shotType: m.segment.sceneData?.shotType,
          cameraMotion: m.segment.cameraMotion,
          motionLevel: m.segment.motionLevel,
          quality: m.segment.quality,
          provenance: m.provenance,
        })),
      }

      const serialized = JSON.stringify(payload)
      const bytes = new TextEncoder().encode(serialized).length
      const approxTokens = Math.round(bytes / 4)

      console.log(`Visual Search Payload (3 candidates): ${bytes} bytes (~${approxTokens} tokens)`)

      expect(bytes).toBeLessThan(2500)
      expect(approxTokens).toBeLessThan(650)
    })
  })
})
