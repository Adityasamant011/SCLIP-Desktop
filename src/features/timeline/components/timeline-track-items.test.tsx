import { Profiler } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TimelineItem } from '@/types/timeline'
import { useTimelineStore } from '../stores/timeline-store'
import { _resetZoomStoreForTest, useZoomStore } from '../stores/zoom-store'

vi.mock('./timeline-item', () => ({
  TimelineItem: ({ item, isCompactWidth }: { item: TimelineItem; isCompactWidth: boolean }) => (
    <div
      data-item-id={item.id}
      data-rich-item-id={item.id}
      data-compact-width={String(isCompactWidth)}
    />
  ),
}))

import { TimelineTrackItems } from './timeline-track-items'

const items: TimelineItem[] = [
  {
    id: 'item-1',
    type: 'video',
    trackId: 'track-1',
    from: 0,
    durationInFrames: 30,
    label: 'One',
    src: 'blob:one',
  },
  {
    id: 'item-2',
    type: 'image',
    trackId: 'track-1',
    from: 35,
    durationInFrames: 30,
    label: 'Two',
    src: 'blob:two',
  },
]

describe('TimelineTrackItems stable DOM renderer', () => {
  beforeEach(() => {
    useTimelineStore.setState({ fps: 30 })
    _resetZoomStoreForTest()
  })

  it('keeps rich clip nodes mounted across rerenders', () => {
    const view = render(
      <TimelineTrackItems trackItems={items} trackLocked={false} trackHidden={false} />,
    )
    const firstItem = view.container.querySelector('[data-rich-item-id="item-1"]')

    view.rerender(
      <TimelineTrackItems trackItems={[...items]} trackLocked={false} trackHidden={false} />,
    )

    expect(view.container.querySelectorAll('[data-rich-item-id]')).toHaveLength(2)
    expect(view.container.querySelector('[data-rich-item-id="item-1"]')).toBe(firstItem)
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(view.container.querySelector('[data-timeline-hit-target="true"]')).toBeNull()
  })

  it('ignores live zoom ticks and publishes compact width only at settle', () => {
    useZoomStore.setState({
      contentLevel: 0.3,
      contentPixelsPerSecond: 30,
    })
    const onRender = vi.fn()
    const view = render(
      <Profiler id="track-items" onRender={onRender}>
        <TimelineTrackItems trackItems={items} trackLocked={false} trackHidden={false} />
      </Profiler>,
    )
    const firstItem = view.container.querySelector('[data-rich-item-id="item-1"]')
    const initialCommitCount = onRender.mock.calls.length

    expect(firstItem).toHaveAttribute('data-compact-width', 'true')

    act(() => {
      useZoomStore.setState({
        level: 2,
        pixelsPerSecond: 200,
        isZoomInteracting: true,
      })
    })

    expect(onRender).toHaveBeenCalledTimes(initialCommitCount)
    expect(firstItem).toHaveAttribute('data-compact-width', 'true')

    act(() => {
      useZoomStore.setState({
        contentLevel: 1,
        contentPixelsPerSecond: 100,
        isZoomInteracting: false,
      })
    })

    expect(onRender).toHaveBeenCalledTimes(initialCommitCount + 1)
    expect(firstItem).toHaveAttribute('data-compact-width', 'false')
    expect(view.container.querySelector('[data-rich-item-id="item-1"]')).toBe(firstItem)
  })
})
