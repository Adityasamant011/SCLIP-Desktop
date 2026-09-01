import { describe, expect, it } from 'vitest'
import { searchLocalMedia } from './local-media-search'

describe('searchLocalMedia', () => {
  it('ranks local visual-caption evidence above a filename-only match', () => {
    const results = searchLocalMedia([
      { id: 'filename', fileName: 'football-notes.mov', mimeType: 'video/mp4' },
      {
        id: 'visual', fileName: 'clip-009.mp4', mimeType: 'video/mp4',
        aiCaptions: [{ timeSec: 3.2, text: 'A football stadium crowd celebrates a goal.', thumbRelPath: 'thumbs/clip-009-3.jpg' }],
      },
    ], 'football stadium')

    expect(results.map((result) => result.mediaId)).toEqual(['visual', 'filename'])
    expect(results[0]).toMatchObject({
      matchedTerms: expect.arrayContaining(['football', 'stadium']),
      evidence: [expect.objectContaining({ source: 'visual_caption', timeSec: 3.2 })],
    })
  })

  it('returns only grounded local evidence and accepts a bounded result count', () => {
    const results = searchLocalMedia([
      { id: 'one', fileName: 'city.mp4', mimeType: 'video/mp4', tags: ['night', 'city'] },
      { id: 'two', fileName: 'city-2.mp4', mimeType: 'video/mp4', tags: ['city'] },
    ], 'city', 1)
    expect(results).toHaveLength(1)
    expect(results[0]?.evidence[0]?.source).toBeDefined()
  })
})
