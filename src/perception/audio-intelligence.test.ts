import { describe, it, expect } from 'vitest'
import {
  analyzeAudioBoundary,
  computeSplitEdit,
  buildAudioSegmentEvidence,
} from './index.ts'

describe('SCLIP Audio Editorial Intelligence (Phase 3)', () => {
  describe('Step 2 & 3 — AudioSegmentEvidence & Truthful Provenance', () => {
    it('creates truthful, structured AudioSegmentEvidence from acoustic signals', () => {
      const evidence = buildAudioSegmentEvidence({
        mediaId: 'media-lecture-audio-1',
        startSec: 14.2,
        endSec: 18.5,
        rmsDb: -26.5,
        peakDb: -6.2,
        noiseFloorDb: -49.0,
        hasVocalization: true,
        breathObserved: false,
        contentHash: 'hash-audio-lecture-01',
      })

      expect(evidence.durationSec).toBe(4.3)
      expect(evidence.speechActivity).toBe('active_speech')
      expect(evidence.rmsDb).toBe(-26.5)
      expect(evidence.peakDb).toBe(-6.2)
      expect(evidence.noiseFloorDb).toBe(-49.0)
      expect(evidence.isClipping).toBe(false)

      // Truthful provenance
      expect(evidence.provenance.waveformAnalyzed).toBe(true)
      expect(evidence.provenance.vadAnalyzed).toBe(true)
      expect(evidence.provenance.transcriptInferred).toBe(false)
      expect(evidence.provenance.spectralAnalyzed).toBe(true)
      expect(evidence.provenance.sourceAssetFingerprint).toBe('sha256:hash-audio-lecture-01')
    })

    it('classifies pre-speech breath intake with confidence when observed', () => {
      const breathEvidence = buildAudioSegmentEvidence({
        mediaId: 'media-speaker-breath-1',
        startSec: 4.1,
        endSec: 4.3,
        rmsDb: -42.0,
        peakDb: -38.0,
        noiseFloorDb: -49.0,
        hasVocalization: false,
        breathObserved: true,
        breathConfidence: 0.88,
      })

      expect(breathEvidence.speechActivity).toBe('breath')
      expect(breathEvidence.breathDetected).toBe(true)
      expect(breathEvidence.breathConfidence).toBe(0.88)
      expect(breathEvidence.breathRange?.startSec).toBe(4.1)
    })
  })

  describe('Step 5, 6, 7, 8, 22 — Boundary Risk Analysis & Contextual Repair', () => {
    it('Risk 1 (Clipped Breath): recommends EXPAND_BREATH_PADDING when incoming speech has immediate onset', () => {
      const inspection = analyzeAudioBoundary({
        outgoingMediaId: 'take-1',
        outgoingTimeSec: 12.5,
        outgoingRmsDb: -35.0,
        incomingMediaId: 'take-2',
        incomingTimeSec: 0.02, // Speech begins at 20ms without inhale padding
        incomingRmsDb: -28.0,
        incomingHasSpeech: true,
        incomingHasBreathOnset: true,
      })

      expect(inspection.boundaryRisks).toContain('CLIPPED_BREATH_ONSET')
      expect(inspection.recommendedRepair.action).toBe('EXPAND_BREATH_PADDING')
      expect(inspection.recommendedRepair.paddingStartMs).toBe(80)
      expect(inspection.recommendedRepair.rationale).toContain('Expand incoming speech padding')
    })

    it('Risk 2 (Zero-Crossing Discontinuity): recommends MICRO_CROSSFADE when both sides have active waveform energy', () => {
      const inspection = analyzeAudioBoundary({
        outgoingMediaId: 'take-1',
        outgoingTimeSec: 15.0,
        outgoingRmsDb: -24.0, // High non-zero energy at cut
        incomingMediaId: 'take-2',
        incomingTimeSec: 3.5,
        incomingRmsDb: -22.0, // High non-zero energy at cut
      })

      expect(inspection.boundaryRisks).toContain('ZERO_CROSSING_DISCONTINUITY')
      expect(inspection.recommendedRepair.action).toBe('MICRO_CROSSFADE')
      expect(inspection.recommendedRepair.crossfadeMs).toBe(15)
      expect(inspection.recommendedRepair.rationale).toContain('micro-crossfade')
    })

    it('Risk 3 (Noise Floor Step): recommends ROOM_TONE_BRIDGE when background noise mismatch >= 6 dB', () => {
      const inspection = analyzeAudioBoundary({
        outgoingMediaId: 'room-quiet',
        outgoingTimeSec: 20.0,
        outgoingNoiseFloorDb: -52.0, // Quiet room
        incomingMediaId: 'room-noisy',
        incomingTimeSec: 4.0,
        incomingNoiseFloorDb: -38.0, // Noisy room (14 dB delta)
      })

      expect(inspection.noiseFloorDeltaDb).toBe(14.0)
      expect(inspection.boundaryRisks).toContain('NOISE_FLOOR_STEP')
      expect(inspection.recommendedRepair.action).toBe('ROOM_TONE_BRIDGE')
      expect(inspection.recommendedRepair.crossfadeMs).toBe(30)
    })

    it('Clean Boundary No-Op: preserves clean pause without applying unnecessary crossfades', () => {
      const inspection = analyzeAudioBoundary({
        outgoingMediaId: 'clean-1',
        outgoingTimeSec: 10.0,
        outgoingRmsDb: -55.0,
        outgoingNoiseFloorDb: -50.0,
        outgoingHasSpeech: false,
        incomingMediaId: 'clean-2',
        incomingTimeSec: 5.0,
        incomingRmsDb: -54.0,
        incomingNoiseFloorDb: -50.0,
        incomingHasSpeech: false,
      })

      expect(inspection.boundaryRisks).toEqual(['NONE'])
      expect(inspection.recommendedRepair.action).toBe('NONE')
      expect(inspection.recommendedRepair.rationale).toContain('clean with natural silence')
    })
  })

  describe('Step 9, 19, 20 — J-Cut and L-Cut Split-Edit Calculations', () => {
    it('J-Cut: places incoming audio ahead of video cut point (audio leads picture)', () => {
      const split = computeSplitEdit({
        type: 'J_CUT',
        videoCutTimelineSec: 10.0, // Video cuts at frame 300 @ 30fps
        audioOffsetSec: 0.5,       // Audio leads by 0.5s (15 frames)
        outgoingMediaId: 'cam-a',
        incomingMediaId: 'cam-b',
        videoTrackId: 'track-v1',
        audioTrackId: 'track-a1',
        fps: 30,
      })

      expect(split.videoCutFrame).toBe(300)
      expect(split.audioCutFrame).toBe(285) // 300 - 15 = 285
      expect(split.audioLeadFrames).toBe(15)
      expect(split.incomingAudioItem.fromFrame).toBe(285)
    })

    it('L-Cut: extends outgoing audio past video cut point (audio trails picture)', () => {
      const split = computeSplitEdit({
        type: 'L_CUT',
        videoCutTimelineSec: 10.0, // Video cuts at frame 300 @ 30fps
        audioOffsetSec: 0.75,      // Audio trails by 0.75s (22.5 -> 23 frames)
        outgoingMediaId: 'cam-a',
        incomingMediaId: 'cam-b',
        videoTrackId: 'track-v1',
        audioTrackId: 'track-a1',
        fps: 30,
      })

      expect(split.videoCutFrame).toBe(300)
      expect(split.audioCutFrame).toBe(323) // 300 + 23 = 323
      expect(split.outgoingAudioItem.durationFrames).toBe(173) // 150 + 23 = 173
    })
  })
})
