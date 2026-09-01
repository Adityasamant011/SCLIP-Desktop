import { describe, expect, it } from 'vitest'
import { buildSemanticMediaMap } from './index.ts'

describe('semantic media map', () => {
  it('joins existing transcript and visual evidence without turning candidates into cuts', () => {
    const map = buildSemanticMediaMap({
      mediaId: 'media-1',
      durationSec: 20,
      transcriptSegments: [
        { text: 'Um, welcome to the tutorial.', startSec: 0, endSec: 2, words: [
          { id: 'w-um', text: 'Um', startSec: 0, endSec: 0.2, confidence: 0.98 },
          { id: 'w-welcome', text: 'welcome', startSec: 0.2, endSec: 0.7, confidence: 0.55 },
        ] },
        { text: 'Welcome to the tutorial.', startSec: 3.8, endSec: 5.5 },
        { text: 'Today we build a timeline. Subscribe for more.', startSec: 5.6, endSec: 8 },
      ],
      visualMoments: [{ timeSec: 0, text: 'A creator speaks to camera.', scene: { shotType: 'medium', subjects: ['creator'] } }],
    })

    expect(map.grounding.overall).toBe('grounded')
    expect(map).toMatchObject({ schemaVersion: 3, analyzerVersion: 'semantic-v3' })
    expect(map.sourceAnchor).toMatchObject({ assetId: 'media-1', assetFingerprint: expect.stringMatching(/^media:/) })
    expect(map.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'filler_language', wordIds: ['w-um'], evidenceType: 'transcript', requiresEditorialReview: true }),
      expect.objectContaining({ kind: 'low_confidence', wordIds: ['w-welcome'] }),
      expect.objectContaining({ kind: 'speech_gap', evidenceType: 'audio-pending', requiresAudioVerification: true }),
      expect.objectContaining({ kind: 'call_to_action' }),
      expect.objectContaining({ kind: 'topic_transition' }),
    ]))
    expect(map.reviewCandidates.every((candidate) => candidate.requiresEditorialReview)).toBe(true)
    expect(map.editorialSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pacing_review', requiresCreatorReview: true }),
      expect.objectContaining({ kind: 'audio_review', requiresCreatorReview: true }),
      expect.objectContaining({ kind: 'caption_opportunity', requiresCreatorReview: true }),
    ]))
    expect(map.visualMoments.at(0)?.scene?.subjects).toEqual(['creator'])
  })

  it('marks exact adjacent repetition as a reviewable retake candidate, never as a cut', () => {
    const map = buildSemanticMediaMap({
      mediaId: 'media-repeat',
      transcriptSegments: [
        { text: 'This is the point.', startSec: 0, endSec: 1 },
        { text: 'This is the point.', startSec: 1.1, endSec: 2 },
      ],
    })

    expect(map.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'repeated_line', requiresEditorialReview: true }),
      expect.objectContaining({ kind: 'retake_candidate', requiresEditorialReview: true }),
    ]))
  })

  it('reports missing evidence clearly instead of inventing an edit plan', () => {
    const map = buildSemanticMediaMap({ mediaId: 'media-2' })

    expect(map.grounding.overall).toBe('insufficient')
    expect(map.reviewCandidates).toEqual([])
    expect(map.recommendedNextSteps).toEqual(expect.arrayContaining([
      expect.stringContaining('transcription'),
      expect.stringContaining('source-footage'),
    ]))
  })
})
