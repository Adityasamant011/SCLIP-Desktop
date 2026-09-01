import { describe, expect, it } from 'vitest'
import { buildTranscriptWordId } from './transcript-word-id'

describe('buildTranscriptWordId', () => {
  it('is stable across timeline usage and normalises harmless transcript punctuation', () => {
    expect(buildTranscriptWordId('media-1', { text: 'Hello!', start: 1.25, end: 1.7 }))
      .toBe('sclip-word:media-1:1250:1700:hello')
    expect(buildTranscriptWordId('media-1', { text: ' hello ', start: 1.25, end: 1.7 }))
      .toBe('sclip-word:media-1:1250:1700:hello')
  })
})
