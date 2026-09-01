import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  clearMediaDragData,
  deferMediaDragDataCleanup,
  getMediaDragData,
  setMediaDragData,
} from './drag-data-cache'

const EXTERNAL_DRAG_CLASS = 'timeline-external-media-drag'

describe('drag-data-cache', () => {
  beforeEach(() => {
    clearMediaDragData()
    document.body.classList.remove(EXTERNAL_DRAG_CLASS)
  })

  afterEach(() => {
    clearMediaDragData()
    document.body.classList.remove(EXTERNAL_DRAG_CLASS)
  })

  it('enables timeline pointer passthrough for external media drags', () => {
    setMediaDragData({
      type: 'media-item',
      mediaId: 'media-1',
      mediaType: 'video',
      fileName: 'clip.mp4',
      duration: 4,
    })

    expect(getMediaDragData()).toMatchObject({ type: 'media-item', mediaId: 'media-1' })
    expect(document.body.classList.contains(EXTERNAL_DRAG_CLASS)).toBe(true)
  })

  it('enables timeline pointer passthrough for composition drags', () => {
    setMediaDragData({
      type: 'composition',
      compositionId: 'composition-1',
      name: 'Compound clip',
      durationInFrames: 120,
      width: 1920,
      height: 1080,
    })

    expect(document.body.classList.contains(EXTERNAL_DRAG_CLASS)).toBe(true)
  })

  it('keeps clip-level pointer events enabled for timeline template drags', () => {
    setMediaDragData({
      type: 'timeline-template',
      itemType: 'adjustment',
      label: 'Glow',
    })

    expect(document.body.classList.contains(EXTERNAL_DRAG_CLASS)).toBe(false)
  })

  it('removes timeline pointer passthrough when the drag cache clears', () => {
    setMediaDragData({
      type: 'media-items',
      items: [
        {
          mediaId: 'media-1',
          mediaType: 'video',
          fileName: 'clip.mp4',
          duration: 4,
        },
      ],
    })

    clearMediaDragData()

    expect(getMediaDragData()).toBeNull()
    expect(document.body.classList.contains(EXTERNAL_DRAG_CLASS)).toBe(false)
  })

  it('keeps a WebKit payload available briefly for the target drop handler', () => {
    vi.useFakeTimers()
    setMediaDragData({
      type: 'media-item',
      mediaId: 'media-1',
      mediaType: 'video',
      fileName: 'clip.mp4',
      duration: 4,
    })

    deferMediaDragDataCleanup()
    expect(getMediaDragData()).not.toBeNull()
    vi.advanceTimersByTime(250)
    expect(getMediaDragData()).toBeNull()
    vi.useRealTimers()
  })
})
