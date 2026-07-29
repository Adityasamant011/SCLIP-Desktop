import { describe, expect, it } from 'vite-plus/test'

import {
  computeCoverDrawRect,
  computeFilmstripCanvasGeometry,
  computeFilmstripCanvasTiles,
} from './filmstrip-canvas-geometry'

describe('computeFilmstripCanvasGeometry', () => {
  it('bounds the canvas to the visible tile window', () => {
    expect(computeFilmstripCanvasGeometry(100_000, 4_000.2, 6_079.4)).toEqual({
      left: 4_000,
      width: 2_080,
    })
  })

  it('clips the visible window at the clip edge', () => {
    expect(computeFilmstripCanvasGeometry(415, 320, 480)).toEqual({
      left: 320,
      width: 95,
    })
    expect(computeFilmstripCanvasGeometry(122.406, 0, 123)).toEqual({
      left: 0,
      width: 123,
    })
  })
})

describe('computeFilmstripCanvasTiles', () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({
    index,
    timestamp: index,
    url: `blob:frame-${index}`,
  }))

  it('resamples the visible real-pixel slots at the current zoom', () => {
    const base = {
      frames,
      renderWidth: 320,
      visibleStartPx: 0,
      visibleEndPx: 320,
      tileWidth: 80,
      effectiveStart: 0,
      effectiveEnd: 8,
      speed: 1,
      isReversed: false,
    }

    expect(
      computeFilmstripCanvasTiles({ ...base, pixelsPerSecond: 80 }).map((tile) => tile.frame.index),
    ).toEqual([0, 1, 2, 3])
    expect(
      computeFilmstripCanvasTiles({ ...base, pixelsPerSecond: 160 }).map(
        (tile) => tile.frame.index,
      ),
    ).toEqual([0, 1, 1, 2])
  })

  it('maps the same slots from the source end when playback is reversed', () => {
    expect(
      computeFilmstripCanvasTiles({
        frames,
        renderWidth: 320,
        visibleStartPx: 0,
        visibleEndPx: 320,
        tileWidth: 80,
        pixelsPerSecond: 80,
        effectiveStart: 0,
        effectiveEnd: 8,
        speed: 1,
        isReversed: true,
      }).map((tile) => tile.frame.index),
    ).toEqual([7, 6, 5, 4])
  })
})

describe('computeCoverDrawRect', () => {
  it('center-crops a wide source into a portrait tile', () => {
    expect(computeCoverDrawRect(160, 90, 60, 60)).toEqual({
      x: expect.closeTo(-23.333, 2),
      y: 0,
      width: expect.closeTo(106.667, 2),
      height: 60,
    })
  })
})
