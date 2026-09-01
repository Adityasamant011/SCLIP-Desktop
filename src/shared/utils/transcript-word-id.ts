import type { MediaTranscriptWord } from '@/types/storage'

function normaliseWordForId(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 48) || 'word'
}

/** A stable source-word reference. A placement-specific edit also needs itemId. */
export function buildTranscriptWordId(mediaId: string, word: Pick<MediaTranscriptWord, 'text' | 'start' | 'end'>): string {
  const startMs = Math.round(Math.max(0, word.start) * 1000)
  const endMs = Math.round(Math.max(word.start, word.end) * 1000)
  return `sclip-word:${mediaId}:${startMs}:${endMs}:${normaliseWordForId(word.text)}`
}
