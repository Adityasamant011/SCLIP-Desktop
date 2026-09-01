import { describe, expect, it } from 'vite-plus/test'
import { buildSpeechDetection, retainWordsInSpeechRanges } from './speech-detection'

describe('buildSpeechDetection', () => {
  it('rejects guitar/noise-like isolated VAD spikes', () => {
    const detection = buildSpeechDetection([
      { start: 0, end: 0.032, probability: 0.11 },
      { start: 5, end: 5.032, probability: 0.78 },
      { start: 5.032, end: 5.064, probability: 0.08 },
    ], 44.604)

    expect(detection).toMatchObject({
      detectionMethod: 'silero_vad_v5.1',
      speechDetected: false,
      speechConfidence: 0.78,
      speechCoverage: 0,
      speechRanges: [],
    })
  })

  it('keeps a spoken phrase together across a short confidence dip', () => {
    const detection = buildSpeechDetection([
      { start: 1, end: 1.032, probability: 0.92 },
      { start: 1.032, end: 1.064, probability: 0.61 },
      { start: 1.064, end: 1.096, probability: 0.42 },
      { start: 1.096, end: 1.128, probability: 0.88 },
      { start: 1.128, end: 1.16, probability: 0.82 },
      { start: 1.16, end: 1.192, probability: 0.8 },
      { start: 1.192, end: 1.224, probability: 0.79 },
      { start: 1.224, end: 1.256, probability: 0.14 },
    ], 5)

    expect(detection.speechDetected).toBe(true)
    expect(detection.speechRanges).toEqual([{ start: 1, end: 1.224 }])
    expect(detection.speechConfidence).toBeGreaterThan(0.8)
  })

  it('does not promote ASR outside VAD-confirmed ranges into dialogue', () => {
    const segments = retainWordsInSpeechRanges([{
      start: 0,
      end: 8,
      words: [
        { text: 'music', start: 0.2, end: 0.5 },
        { text: 'actual', start: 4.1, end: 4.4 },
        { text: 'speech', start: 4.45, end: 4.8 },
        { text: 'noise', start: 7.1, end: 7.5 },
      ],
    }], [{ start: 4, end: 5 }])

    expect(segments).toEqual([{
      start: 4.1,
      end: 4.8,
      words: [
        { text: 'actual', start: 4.1, end: 4.4 },
        { text: 'speech', start: 4.45, end: 4.8 },
      ],
    }])
  })
})
