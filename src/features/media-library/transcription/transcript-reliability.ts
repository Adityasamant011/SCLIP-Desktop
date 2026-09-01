import type { MediaTranscript, MediaTranscriptWord } from '@/types/storage'
import type { SpeechDetection } from './speech-detection'

export type TranscriptReliabilityReason =
  | 'NO_STABLE_WORD_TIMINGS'
  | 'NO_RELIABLE_SPEECH'
  | 'INSUFFICIENT_LEXICAL_WORDS'
  | 'INSUFFICIENT_SPEECH_COVERAGE'
  | 'HIGH_UNKNOWN_TOKEN_RATIO'
  | 'HIGH_MALFORMED_TOKEN_RATIO'
  | 'LOW_ASR_CONFIDENCE'

export interface TranscriptSpeechRange {
  start: number
  end: number
}

/**
 * A conservative, local trust decision for ASR output. Silero VAD supplies
 * primary speech-presence evidence for new transcripts; the ASR checks remain
 * a second line of defence for legacy transcripts and nonspeech hallucinations.
 */
export interface TranscriptReliability {
  version: 1
  detectionMethod: 'silero_vad_v5.1' | 'asr_sanity_v1'
  speechDetected: boolean
  speechConfidence: number
  speechCoverage: number
  speechRanges: TranscriptSpeechRange[]
  transcriptReliable: boolean
  reliabilityScore: number
  reliabilityReasons: TranscriptReliabilityReason[]
}

const UNKNOWN_TOKEN = /^<\s*unk\s*>$/i
const HAS_LEXICAL_TEXT = /\p{L}{2,}/u

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))))
}

function wordsFromTranscript(transcript: Pick<MediaTranscript, 'segments'>): MediaTranscriptWord[] {
  return transcript.segments.flatMap((segment) => segment.words ?? [])
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
}

function mergeRanges(words: readonly MediaTranscriptWord[]): TranscriptSpeechRange[] {
  const ranges = words
    .filter((word) => !UNKNOWN_TOKEN.test(word.text.trim()) && HAS_LEXICAL_TEXT.test(word.text))
    .map((word) => ({ start: word.start, end: word.end }))
    .sort((left, right) => left.start - right.start)
  const merged: TranscriptSpeechRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    // Joining a short within-phrase gap makes coverage reflect speech spans,
    // rather than individual phoneme/word timings.
    if (previous && range.start <= previous.end + 0.35) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Reject only when independent warning signals agree. Unknown/malformed token
 * ratios protect music/noise cases; coverage and lexical-word count prevent a
 * stray ASR fragment from being promoted into editable dialogue. Confidence is
 * used only when an ASR worker actually supplied it.
 */
export function evaluateTranscriptReliability(
  transcript: Pick<MediaTranscript, 'segments'>,
  mediaDurationSeconds: number | undefined,
  speechDetection?: SpeechDetection,
): TranscriptReliability {
  const words = wordsFromTranscript(transcript)
  const wordCount = words.length
  const unknownCount = words.filter((word) => UNKNOWN_TOKEN.test(word.text.trim())).length
  const lexicalCount = words.filter((word) => !UNKNOWN_TOKEN.test(word.text.trim()) && HAS_LEXICAL_TEXT.test(word.text)).length
  const malformedCount = words.filter((word) => !UNKNOWN_TOKEN.test(word.text.trim()) && !HAS_LEXICAL_TEXT.test(word.text)).length
  const unknownRatio = wordCount ? unknownCount / wordCount : 1
  const malformedRatio = wordCount ? malformedCount / wordCount : 1
  const confidenceValues = words.flatMap((word) => typeof word.confidence === 'number' && Number.isFinite(word.confidence) ? [word.confidence] : [])
  const averageConfidence = confidenceValues.length
    ? confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length
    : undefined
  const asrSpeechRanges = mergeRanges(words)
  const asrSpeechDuration = asrSpeechRanges.reduce((total, range) => total + range.end - range.start, 0)
  const asrSpeechCoverage = mediaDurationSeconds && mediaDurationSeconds > 0
    ? clampScore(asrSpeechDuration / mediaDurationSeconds)
    : wordCount > 0 ? 1 : 0
  const speechRanges = speechDetection?.speechRanges ?? asrSpeechRanges
  const speechCoverage = speechDetection?.speechCoverage ?? asrSpeechCoverage

  const reasons: TranscriptReliabilityReason[] = []
  if (speechDetection && !speechDetection.speechDetected) reasons.push('NO_RELIABLE_SPEECH')
  if (!wordCount) reasons.push('NO_STABLE_WORD_TIMINGS')
  if (lexicalCount < 2) reasons.push('INSUFFICIENT_LEXICAL_WORDS')
  // 0.5% is roughly 0.3 seconds in a one-minute clip: enough to reject an
  // isolated decoding blip, while allowing a short real spoken answer.
  if (wordCount > 0 && speechCoverage < 0.005) reasons.push('INSUFFICIENT_SPEECH_COVERAGE')
  // A quarter unknown tokens or half non-lexical tokens is strong evidence
  // against promoting ASR output into an editable dialogue transcript.
  if (unknownRatio >= 0.25) reasons.push('HIGH_UNKNOWN_TOKEN_RATIO')
  if (malformedRatio >= 0.5) reasons.push('HIGH_MALFORMED_TOKEN_RATIO')
  if (averageConfidence !== undefined && averageConfidence < 0.45) reasons.push('LOW_ASR_CONFIDENCE')

  const penalty =
    (speechDetection && !speechDetection.speechDetected ? 1 : 0) +
    (unknownRatio >= 0.25 ? 0.45 : 0) +
    (malformedRatio >= 0.5 ? 0.3 : 0) +
    (lexicalCount < 2 ? 0.25 : 0) +
    (wordCount > 0 && speechCoverage < 0.005 ? 0.15 : 0) +
    (averageConfidence !== undefined && averageConfidence < 0.45 ? 0.25 : 0)
  const reliabilityScore = clampScore(1 - penalty)
  const transcriptReliable = (speechDetection?.speechDetected ?? true) && reasons.length === 0 && reliabilityScore >= 0.7

  return {
    version: 1,
    detectionMethod: speechDetection?.detectionMethod ?? 'asr_sanity_v1',
    speechDetected: speechDetection?.speechDetected ?? transcriptReliable,
    speechConfidence: speechDetection?.speechConfidence ?? (averageConfidence === undefined ? reliabilityScore : clampScore(averageConfidence)),
    speechCoverage,
    speechRanges: transcriptReliable ? speechRanges : [],
    transcriptReliable,
    reliabilityScore,
    reliabilityReasons: reasons,
  }
}

export function getTranscriptReliability(
  transcript: MediaTranscript,
  mediaDurationSeconds: number | undefined,
): TranscriptReliability {
  return transcript.reliability ?? evaluateTranscriptReliability(transcript, mediaDurationSeconds)
}
