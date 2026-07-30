// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import type { TimelineItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import type { Transition } from '@/types/transition'
import {
  buildMediaMetadataMap,
  collectSourceRangeFindings,
  collectTransitionFindings,
  collectTransformParentFindings,
  hasAudioCapableItems,
  videoCarriesAudio,
} from './validation'

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

describe('audio-capability helpers', () => {
  const withAudio = { ...makeMetadata(), audioCodec: 'aac' } as MediaMetadata
  const silent = { ...makeMetadata(), audioCodec: undefined } as MediaMetadata

  it('buildMediaMetadataMap keeps only entries that carry metadata', () => {
    const map = buildMediaMetadataMap([{ mediaId: 'a', metadata: withAudio }, { mediaId: 'b' }])
    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(false)
  })

  it('video without an audio track (per metadata) cannot carry audio', () => {
    const map = new Map([['m', silent]])
    expect(videoCarriesAudio({ mediaId: 'm' }, map)).toBe(false)
  })

  it('embeddedAudioMuted silences the video regardless of metadata', () => {
    const map = new Map([['m', withAudio]])
    expect(videoCarriesAudio({ mediaId: 'm', embeddedAudioMuted: true }, map)).toBe(false)
    expect(videoCarriesAudio({ mediaId: 'm' }, map)).toBe(true)
  })

  it('unknown metadata assumes the video may carry audio (no false negatives)', () => {
    expect(videoCarriesAudio({ mediaId: 'unknown' }, new Map())).toBe(true)
  })

  it('hasAudioCapableItems skips muted and hidden tracks', () => {
    const map = new Map([['m', withAudio]])
    const item = { id: 'v', type: 'video', mediaId: 'm', from: 0, durationInFrames: 10 }
    const track = (overrides: Record<string, unknown>) =>
      ({ id: 't', items: [item], ...overrides }) as never
    expect(hasAudioCapableItems([track({})], map)).toBe(true)
    expect(hasAudioCapableItems([track({ muted: true })], map)).toBe(false)
    expect(hasAudioCapableItems([track({ visible: false })], map)).toBe(false)
  })
})

describe('collectTransitionFindings', () => {
  const makeTransition = (overrides: Partial<Transition> = {}): Transition =>
    ({
      id: 'tr-1',
      type: 'crossfade',
      presentation: 'fade',
      timing: 'linear',
      leftClipId: 'left',
      rightClipId: 'right',
      trackId: 't1',
      durationInFrames: 10,
      ...overrides,
    }) as Transition

  const adjacentPair = (): TimelineItem[] => [
    makeVideo({ id: 'left', from: 0, durationInFrames: 50 }),
    makeVideo({ id: 'right', from: 50, durationInFrames: 50 }),
  ]

  it('accepts touching clips on one track with a presentation', () => {
    expect(collectTransitionFindings([makeTransition()], adjacentPair())).toEqual([])
  })

  it('tolerates a 1-frame seam and an overlap (both render)', () => {
    const oneFrameGap = [
      makeVideo({ id: 'left', from: 0, durationInFrames: 50 }),
      makeVideo({ id: 'right', from: 51, durationInFrames: 50 }),
    ]
    expect(collectTransitionFindings([makeTransition()], oneFrameGap)).toEqual([])
    const overlap = [
      makeVideo({ id: 'left', from: 0, durationInFrames: 60 }),
      makeVideo({ id: 'right', from: 50, durationInFrames: 50 }),
    ]
    expect(collectTransitionFindings([makeTransition()], overlap)).toEqual([])
  })

  it('flags a missing participant clip', () => {
    const findings = collectTransitionFindings(
      [makeTransition({ rightClipId: 'ghost' })],
      adjacentPair(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ transitionId: 'tr-1', kind: 'clip_not_found' })
    expect(findings[0]!.message).toContain('ghost')
  })

  it('flags clips on different tracks', () => {
    const items = [
      makeVideo({ id: 'left', from: 0, durationInFrames: 50, trackId: 't1' }),
      makeVideo({ id: 'right', from: 50, durationInFrames: 50, trackId: 't2' }),
    ]
    expect(collectTransitionFindings([makeTransition()], items)[0]).toMatchObject({
      kind: 'cross_track',
    })
  })

  it('flags a gap wider than one frame (the planner builds no window)', () => {
    const items = [
      makeVideo({ id: 'left', from: 0, durationInFrames: 50 }),
      makeVideo({ id: 'right', from: 53, durationInFrames: 50 }),
    ]
    const findings = collectTransitionFindings([makeTransition()], items)
    expect(findings[0]).toMatchObject({ kind: 'not_adjacent' })
    expect(findings[0]!.message).toContain('3 frames apart')
  })

  it('flags an unknown direction (renders the window black)', () => {
    const findings = collectTransitionFindings(
      [makeTransition({ direction: 'left' as Transition['direction'] })],
      adjacentPair(),
    )
    expect(findings[0]).toMatchObject({ kind: 'invalid_direction' })
    expect(findings[0]!.message).toContain('from-left')
    expect(
      collectTransitionFindings([makeTransition({ direction: 'from-left' })], adjacentPair()),
    ).toEqual([])
  })

  it('flags a missing presentation (renders as a hard cut)', () => {
    const transition = makeTransition()
    delete (transition as unknown as Record<string, unknown>).presentation
    expect(collectTransitionFindings([transition], adjacentPair())[0]).toMatchObject({
      kind: 'missing_presentation',
    })
  })
})

describe('collectTransformParentFindings', () => {
  const rigPair = (childOverrides = {}) => [
    makeVideo({ id: 'body' }),
    makeVideo({
      id: 'arm',
      transformParent: {
        parentItemId: 'body',
        childLocalReference: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
        childWorldReference: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
        parentReference: { x: 0, y: 0, width: 200, height: 200, rotation: 0 },
      },
      ...childOverrides,
    }),
  ]

  it('accepts a valid binding and unparented items', () => {
    expect(collectTransformParentFindings(rigPair())).toEqual([])
    expect(collectTransformParentFindings([makeVideo({ id: 'solo' })])).toEqual([])
  })

  it('flags a missing parent (child renders unparented)', () => {
    const items = rigPair()
    ;(items[1] as { transformParent: { parentItemId: string } }).transformParent.parentItemId =
      'ghost'
    expect(collectTransformParentFindings(items)[0]).toMatchObject({
      itemId: 'arm',
      kind: 'parent_not_found',
    })
  })

  it('flags audio/adjustment participants', () => {
    const items = rigPair()
    ;(items[0] as { type: string }).type = 'audio'
    expect(collectTransformParentFindings(items)[0]).toMatchObject({ kind: 'invalid_type' })
  })

  it('flags a parent cycle', () => {
    const items = rigPair()
    ;(items[0] as Record<string, unknown>).transformParent = {
      parentItemId: 'arm',
      childLocalReference: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      childWorldReference: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    }
    const findings = collectTransformParentFindings(items)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings.every((finding) => finding.kind === 'cycle')).toBe(true)
  })
})
