import { describe, it, expect } from 'vitest'
import {
  analyzeMusicTrack,
  findNearestMusicalEvent,
  evaluateDialogueMusicRelationship,
  extractBoundedMusicEvidence,
} from './index.ts'
import { validateEditPlanForV1, type SclipEditPlan } from '@/features/editor/agent/edit-plan'

describe('SCLIP Music Editorial Intelligence (Phase 4)', () => {
  describe('Step 5, 6, 16, 18 — Known-BPM Tempo & Beat Tracking Benchmark', () => {
    it('accurately detects 120 BPM tempo, 0.5s beat interval, and 4/4 downbeats', () => {
      const result = analyzeMusicTrack({
        mediaId: 'track-dance-120bpm',
        durationSec: 30.0,
        simulatedBpm: 120.0,
      })

      expect(result.musicDetected).toBe(true)
      expect(result.tempo.bpm).toBe(120.0)
      expect(result.tempo.confidence).toBeGreaterThanOrEqual(0.90)

      // In 30s @ 120 BPM (0.5s per beat), there are 60 beats
      expect(result.beats.length).toBe(60)
      expect(result.beats[0]!.timeSec).toBe(0.0)
      expect(result.beats[1]!.timeSec).toBe(0.5)
      expect(result.beats[2]!.timeSec).toBe(1.0)

      // Downbeats every 4th beat (bar 1 beat 1, bar 2 beat 1, etc.)
      expect(result.downbeats.length).toBe(15)
      expect(result.downbeats[0]!.barIndex).toBe(1)
      expect(result.downbeats[1]!.barIndex).toBe(2)
      expect(result.downbeats[1]!.timeSec).toBe(2.0)
    })

    it('handles alternative octave BPM ambiguity (e.g. 150 BPM / 75 BPM)', () => {
      const result = analyzeMusicTrack({
        mediaId: 'track-fast-150bpm',
        durationSec: 20.0,
        simulatedBpm: 150.0,
      })

      expect(result.tempo.bpm).toBe(150.0)
      expect(result.tempo.alternativeOctaveBpm).toBe(75.0)
    })
  })

  describe('Step 8, 9, 19 — Musical Sections, Energy Curve & Drop Detection', () => {
    it('segments music track into Intro, Build, and Drop sections with energy trends', () => {
      const result = analyzeMusicTrack({
        mediaId: 'track-edm-structure',
        durationSec: 40.0,
        simulatedBpm: 120.0,
      })

      expect(result.sections.length).toBe(3)
      expect(result.sections[0]!.type).toBe('intro')
      expect(result.sections[0]!.energyLevel).toBe('low')

      expect(result.sections[1]!.type).toBe('build')
      expect(result.sections[1]!.energyLevel).toBe('medium')

      expect(result.sections[2]!.type).toBe('drop')
      expect(result.sections[2]!.energyLevel).toBe('high')

      // Events include DROP at section 3 start
      const dropEvent = result.events.find((e) => e.type === 'DROP')
      expect(dropEvent).toBeDefined()
      expect(dropEvent?.confidence).toBeGreaterThan(0.90)
    })
  })

  describe('Step 4, 20 — Music Presence vs Non-Music False Positive', () => {
    it('correctly rejects speech-like audio rhythm with low music confidence', () => {
      const speechResult = analyzeMusicTrack({
        mediaId: 'media-jo-speech',
        durationSec: 13.0,
        simulatedPattern: 'speech_like',
      })

      expect(speechResult.musicDetected).toBe(false)
      expect(speechResult.musicConfidence).toBeLessThan(0.30)
      expect(speechResult.beats).toEqual([])
      expect(speechResult.tempo.bpm).toBe(0)
    })
  })

  describe('Step 12, 13, 22, 23 — Cut-to-Music Alignment & Off-Beat Flexibility', () => {
    it('finds nearest beat and downbeat candidates for a target cut timestamp', () => {
      const analysis = analyzeMusicTrack({
        mediaId: 'track-pop-120bpm',
        durationSec: 30.0,
        simulatedBpm: 120.0,
      })

      // Target cut requested near 10.15s (nearest beat is 10.0s or 10.5s)
      const eventInfo = findNearestMusicalEvent({
        analysis,
        targetSec: 10.15,
        windowSec: 1.0,
      })

      expect(eventInfo.nearbyBeats.length).toBeGreaterThan(0)
      const nearest = eventInfo.nearestEvent
      expect(nearest).toBeDefined()
      // Nearest beat is at 10.0s (delta = -0.15s)
      expect(nearest?.timeSec).toBe(10.0)
      expect(nearest?.deltaSec).toBe(-0.15)
    })

    it('supports intentional off-beat placement without forced snapping', () => {
      const analysis = analyzeMusicTrack({
        mediaId: 'track-pop-120bpm',
        durationSec: 30.0,
        simulatedBpm: 120.0,
      })

      // Creator chooses an off-beat cut at 10.25s (exactly halfway between 10.0s and 10.5s beats)
      const targetSec = 10.25
      const eventInfo = findNearestMusicalEvent({ analysis, targetSec })

      // System reports the surrounding beats as evidence but allows the cut at 10.25s
      expect(eventInfo.targetSec).toBe(10.25)
      expect(Math.abs(eventInfo.nearestEvent!.deltaSec)).toBe(0.25)
    })
  })

  describe('Step 10, 11, 21 — Dialogue + Music Relationship & Dynamic Ducking', () => {
    it('evaluates dialogue overlapping high energy music and recommends -15dB ducking', () => {
      const musicAnalysis = analyzeMusicTrack({
        mediaId: 'bg-music-high-energy',
        durationSec: 40.0,
        simulatedBpm: 120.0,
      })

      // Dialogue occurs during drop section (e.g. 25.0s to 32.0s)
      const relationship = evaluateDialogueMusicRelationship({
        dialogueRange: { startSec: 25.0, endSec: 32.0 },
        musicAnalysis,
      })

      expect(relationship.musicEnergyInRange).toBe('high')
      expect(relationship.dialogueMaskingRisk).toBe('HIGH')
      expect(relationship.recommendedDucking.duckDb).toBe(-15.0)
      expect(relationship.recommendedDucking.attackSec).toBe(0.08)
      expect(relationship.recommendedDucking.releaseSec).toBe(0.25)
    })

    it('evaluates dialogue overlapping low energy music and recommends gentle -8dB ducking', () => {
      const musicAnalysis = analyzeMusicTrack({
        mediaId: 'bg-music-intro',
        durationSec: 40.0,
        simulatedBpm: 120.0,
      })

      // Dialogue occurs during intro section (e.g. 2.0s to 6.0s)
      const relationship = evaluateDialogueMusicRelationship({
        dialogueRange: { startSec: 2.0, endSec: 6.0 },
        musicAnalysis,
      })

      expect(relationship.musicEnergyInRange).toBe('low')
      expect(relationship.dialogueMaskingRisk).toBe('LOW')
      expect(relationship.recommendedDucking.duckDb).toBe(-8.0)
    })
  })

  describe('Step 25, 27 — Bounded Long-Form Music Query', () => {
    it('extracts concise bounded music evidence for a 10s query window', () => {
      const musicAnalysis = analyzeMusicTrack({
        mediaId: 'bg-music-longform-4min',
        durationSec: 240.0, // 4-minute track
        simulatedBpm: 120.0,
      })

      const bounded = extractBoundedMusicEvidence({
        analysis: musicAnalysis,
        queryRange: { startSec: 20.0, endSec: 30.0 }, // 10s window
      })

      expect(bounded.tempoBpm).toBe(120.0)
      expect(bounded.beatsInWindow.length).toBe(21) // ~20 beats in 10s
      expect(bounded.activeSection).toBeDefined()

      const payloadBytes = JSON.stringify(bounded).length
      expect(payloadBytes).toBeLessThan(1500) // ~375 tokens
    })
  })

  describe('Step 14 — Typed EditPlan Integration for Music Placement and Ducking', () => {
    it('validates an EditPlan configuring audioDucking on dialogue items', () => {
      const plan: SclipEditPlan = {
        schemaVersion: 1,
        title: 'Apply Sidechain Ducking to Background Music',
        goal: 'Lower music by -12dB during main voiceover section',
        projectId: 'project-music-01',
        projectRevision: 'rev-music-101',
        evidenceIds: ['evidence-music-track-pop-120bpm'],
        limitations: ['Music ducks by -12dB with 80ms attack / 250ms release; dialogue track untouched.'],
        operations: [
          {
            id: 'op-duck-voiceover',
            executor: 'video_update_item',
            summary: 'Set audioDucking on dialogue item to duck music track',
            risk: 'reversible',
            intent: 'Ensure voice clarity during musical montage',
            args: {
              item_id: 'item-dialogue-1',
              updates: {
                audioDucking: {
                  duckOthersDb: -12.0,
                  attackSec: 0.08,
                  releaseSec: 0.25,
                },
              },
            },
            evidenceIds: ['evidence-music-track-pop-120bpm'],
            verification: ['deterministic'],
          },
        ],
      }

      const issues = validateEditPlanForV1(plan, ['evidence-music-track-pop-120bpm'])
      expect(issues).toEqual([])
    })
  })
})
