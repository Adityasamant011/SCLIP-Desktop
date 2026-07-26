// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import type { TimelineItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import { collectSourceRangeFindings } from './validation'

function makeMetadata(): MediaMetadata {
  return {
    id: 'media-1',
    fileName: 'clip.mp4',
    fileSize: 1000,
    mimeType: 'video/mp4',
    duration: 5.6,
    width: 1920,
    height: 1080,
    fps: 25,
    codec: 'h264',
    bitrate: 1_000_000,
  } as MediaMetadata
}

function makeVideo(overrides: Partial<TimelineItem> & Record<string, unknown> = {}): TimelineItem {
  return {
    id: 'clip-1',
    type: 'video',
    trackId: 't1',
    from: 0,
    durationInFrames: 100,
    label: 'clip',
    mediaId: 'media-1',
    ...overrides,
  } as TimelineItem
}

describe('collectSourceRangeFindings', () => {
  const mediaById = new Map([['media-1', makeMetadata()]])

  it('flags an item whose source cut runs past the end of the media', () => {
    // Bug-report repro: 5.60s media, srcIn 0.9s + 5.38s used = 6.28s needed.
    const item = makeVideo({
      sourceStart: 0.9 * 25,
      sourceEnd: 6.28 * 25,
      durationInFrames: Math.round(5.38 * 25),
    })
    const findings = collectSourceRangeFindings([item], mediaById, 25)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ itemId: 'clip-1', mediaId: 'media-1' })
    expect(findings[0]!.neededSeconds).toBeCloseTo(6.28, 2)
    expect(findings[0]!.availableSeconds).toBeCloseTo(5.6, 2)
  })

  it('accepts a cut that fits (with rounding tolerance)', () => {
    const exact = makeVideo({ sourceStart: 0, sourceEnd: 5.6 * 25 })
    const nearlyExact = makeVideo({ id: 'clip-2', sourceStart: 0, sourceEnd: 5.6 * 25 + 0.4 })
    expect(collectSourceRangeFindings([exact, nearlyExact], mediaById, 25)).toEqual([])
  })

  it('derives the needed range from duration and speed when sourceEnd is absent', () => {
    // 100 timeline frames at 25fps and 2x speed consume 8s of source — over 5.6s.
    const item = makeVideo({ sourceStart: 0, sourceEnd: undefined, speed: 2 })
    const findings = collectSourceRangeFindings([item], mediaById, 25)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.neededSeconds).toBeCloseTo(8, 2)
  })

  it('skips items without media metadata and non-av items', () => {
    const noMeta = makeVideo({ mediaId: 'unknown' })
    const image = makeVideo({ type: 'image' })
    expect(collectSourceRangeFindings([noMeta, image], mediaById, 25)).toEqual([])
  })
})
