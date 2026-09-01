/** Local, cheap speech-presence evidence produced before ASR is allowed to run. */
export interface SpeechRange {
  start: number
  end: number
}

export interface SpeechDetectionMetrics {
  ortImportMs: number
  sessionInitMs: number
  modelLoadMs: number
  sessionCreateMs: number
  decodeMs: number
  resampleMs: number
  inferenceMs: number
  totalDetectMs: number
  processedSeconds: number
  windowCount: number
}

export interface SpeechDetection {
  version: 1
  detectionMethod: 'silero_vad_v5.1'
  speechDetected: boolean
  /** Mean VAD probability over accepted speech windows. */
  speechConfidence: number
  speechCoverage: number
  speechRanges: SpeechRange[]
  metrics?: SpeechDetectionMetrics
}

export interface VadWindow {
  start: number
  end: number
  probability: number
}

interface TimedWord {
  start: number
  end: number
}

interface TimedSegment<TWord extends TimedWord> {
  start: number
  end: number
  words?: TWord[]
}

const clamp = (value: number) => Math.max(0, Math.min(1, Number(value.toFixed(3))))

/**
 * Convert Silero's 32 ms probability windows into useful editor ranges. The
 * two thresholds intentionally use hysteresis: a region needs the model's
 * standard 0.5 confidence to open, but a short dip must fall below 0.35 to
 * close it. This avoids chopping a sentence at an unvoiced consonant.
 */
export function buildSpeechDetection(
  windows: readonly VadWindow[],
  mediaDurationSeconds: number,
  metrics?: SpeechDetectionMetrics,
): SpeechDetection {
  const ranges: SpeechRange[] = []
  const acceptedProbabilities: number[] = []
  let activeStart: number | undefined
  let lastSpeechEnd = 0

  for (const window of windows) {
    if (window.probability >= 0.5) {
      activeStart ??= window.start
      lastSpeechEnd = window.end
      acceptedProbabilities.push(window.probability)
      continue
    }
    if (activeStart !== undefined && window.probability < 0.35) {
      // A 0.2 s tolerance preserves natural micro-pauses while refusing a
      // single isolated VAD spike as meaningful dialogue.
      if (lastSpeechEnd - activeStart >= 0.2) ranges.push({ start: activeStart, end: lastSpeechEnd })
      activeStart = undefined
    }
  }
  if (activeStart !== undefined && lastSpeechEnd - activeStart >= 0.2) {
    ranges.push({ start: activeStart, end: lastSpeechEnd })
  }

  const speechDuration = ranges.reduce((total, range) => total + range.end - range.start, 0)
  return {
    version: 1,
    detectionMethod: 'silero_vad_v5.1',
    speechDetected: ranges.length > 0,
    speechConfidence: acceptedProbabilities.length
      ? clamp(acceptedProbabilities.reduce((total, value) => total + value, 0) / acceptedProbabilities.length)
      : 0,
    speechCoverage: mediaDurationSeconds > 0 ? clamp(speechDuration / mediaDurationSeconds) : 0,
    speechRanges: ranges,
    ...(metrics ? { metrics } : {}),
  }
}

/**
 * Keep only ASR words that overlap VAD-confirmed speech. This is the trust
 * boundary for the current streaming ASR worker: until its PCM handoff is
 * range-aware, it may decode a whole selected file, but words outside real
 * speech can never become captions, script tokens, or editorial evidence.
 */
export function retainWordsInSpeechRanges<TWord extends TimedWord, TSegment extends TimedSegment<TWord>>(
  segments: readonly TSegment[],
  ranges: readonly SpeechRange[] | undefined,
): TSegment[] {
  if (!ranges) return [...segments]
  return segments.flatMap((segment) => {
    const words = (segment.words ?? []).filter((word) =>
      ranges.some((range) => word.end > range.start && word.start < range.end),
    )
    if (words.length === 0) return []
    return [{
      ...segment,
      start: words[0]!.start,
      end: words.at(-1)!.end,
      words,
    }]
  })
}
