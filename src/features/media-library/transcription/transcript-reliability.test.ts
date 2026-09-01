import { describe, expect, it } from 'vite-plus/test'
import type { MediaTranscript } from '@/types/storage'
import { buildSpeechDetection } from './speech-detection'
import { evaluateTranscriptReliability, getTranscriptReliability } from './transcript-reliability'

function transcript(words: MediaTranscript['segments'][number]['words']): Pick<MediaTranscript, 'segments'> {
  return {
    segments: [{
      text: words?.map((word) => word.text).join(' ') ?? '',
      start: words?.[0]?.start ?? 0,
      end: words?.at(-1)?.end ?? 0,
      words,
    }],
  }
}

describe('evaluateTranscriptReliability', () => {
  it('keeps the known guitar hallucination outside the editable script boundary', () => {
    const guitar = transcript([
      { text: '2.', start: 17.84, end: 18.1 },
      { text: 'Cigar', start: 18.1, end: 18.8 },
      { text: 'iggununes', start: 25, end: 26 },
      { text: '<unk>', start: 26, end: 27 },
      { text: '<unk>', start: 27, end: 28 },
      { text: '2-0', start: 35, end: 36 },
    ])

    const result = evaluateTranscriptReliability(guitar, 44.604, {
      version: 1,
      detectionMethod: 'silero_vad_v5.1',
      speechDetected: false,
      speechConfidence: 0.03,
      speechCoverage: 0,
      speechRanges: [],
    })

    expect(result).toMatchObject({
      speechDetected: false,
      transcriptReliable: false,
      speechRanges: [],
    })
    expect(result.reliabilityReasons).toEqual(expect.arrayContaining([
      'NO_RELIABLE_SPEECH',
      'HIGH_UNKNOWN_TOKEN_RATIO',
    ]))
  })

  it('accepts clear timestamped speech when VAD agrees', () => {
    const words = [
      'Most', 'people', 'make', 'this', 'mistake', 'when', 'editing', 'videos',
    ].map((text, index) => ({ text, start: index * 0.38, end: index * 0.38 + 0.28, confidence: 0.94 }))
    const result = evaluateTranscriptReliability(transcript(words), 6, buildSpeechDetection([
      { start: 0, end: 0.032, probability: 0.91 },
      { start: 0.032, end: 0.064, probability: 0.88 },
      { start: 0.064, end: 0.096, probability: 0.87 },
      { start: 0.096, end: 0.128, probability: 0.85 },
      { start: 0.128, end: 0.16, probability: 0.82 },
      { start: 0.16, end: 0.192, probability: 0.81 },
      { start: 0.192, end: 0.224, probability: 0.8 },
      { start: 0.224, end: 0.256, probability: 0.2 },
    ], 6))

    expect(result).toMatchObject({ speechDetected: true, transcriptReliable: true })
    expect(result.speechRanges).not.toEqual([])
  })

  it('continues to reject legacy raw ASR that has no stored VAD result', () => {
    const result = getTranscriptReliability({
      id: 'legacy', mediaId: 'legacy', model: 'parakeet-tdt-v3', quantization: 'hybrid', text: '<<unk>> 2-0',
      segments: [{ text: '<unk> 2-0', start: 0, end: 1, words: [
        { text: '<unk>', start: 0, end: 0.4 }, { text: '2-0', start: 0.4, end: 1 },
      ] }], createdAt: 0, updatedAt: 0,
    }, 10)

    expect(result.transcriptReliable).toBe(false)
    expect(result.reliabilityReasons).toContain('HIGH_UNKNOWN_TOKEN_RATIO')
  })
})
