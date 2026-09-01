import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@/types/timeline'
import { buildScriptTimelineRevision } from './script-timeline-revision'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: 'clip-a',
    type: 'video',
    trackId: 'track-1',
    from: 0,
    durationInFrames: 300,
    mediaId: 'media-a',
    sourceStart: 0,
    sourceEnd: 300,
    sourceFps: 30,
    speed: 1,
    src: 'blob:test',
    ...overrides,
  } as TimelineItem
}

describe('buildScriptTimelineRevision', () => {
  it('is independent of item-array order', async () => {
    const first = item({ id: 'a' })
    const second = item({ id: 'b', from: 300 })
    await expect(buildScriptTimelineRevision({ fps: 30, items: [first, second] }))
      .resolves.toBe(await buildScriptTimelineRevision({ fps: 30, items: [second, first] }))
  })

  it('changes when a word placement can change', async () => {
    const original = await buildScriptTimelineRevision({ fps: 30, items: [item()] })
    const moved = await buildScriptTimelineRevision({ fps: 30, items: [item({ from: 42 })] })
    const trimmed = await buildScriptTimelineRevision({ fps: 30, items: [item({ sourceStart: 15 })] })

    expect(moved).not.toBe(original)
    expect(trimmed).not.toBe(original)
  })

  it('does not invalidate a script preview for visual-only metadata changes', async () => {
    const original = await buildScriptTimelineRevision({ fps: 30, items: [item()] })
    const renamed = await buildScriptTimelineRevision({ fps: 30, items: [item({ label: 'Renamed clip' })] })

    expect(renamed).toBe(original)
  })

  it('does not invalidate a script preview when an unrelated graphic changes', async () => {
    const original = await buildScriptTimelineRevision({ fps: 30, items: [item()] })
    const withTitle = await buildScriptTimelineRevision({
      fps: 30,
      items: [item(), {
        id: 'title', type: 'text', trackId: 'track-title', from: 0, durationInFrames: 90, text: 'Hello',
      } as TimelineItem],
    })

    expect(withTitle).toBe(original)
  })
})
