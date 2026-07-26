// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import {
  calculateContainedMediaDrawLayout,
  calculateMediaDrawDimensions,
  hasCropFeather,
} from './media-draw'

const CANVAS = { width: 1920, height: 1080, fps: 25 }

describe('calculateMediaDrawDimensions', () => {
  it('uses the explicit transform box centered on canvas center + offset', () => {
    const rect = calculateMediaDrawDimensions(
      1280,
      720,
      { x: 100, y: -50, width: 640, height: 360 },
      CANVAS,
    )
    expect(rect).toEqual({
      x: 1920 / 2 + 100 - 320,
      y: 1080 / 2 - 50 - 180,
      width: 640,
      height: 360,
    })
  })

  it('contain-fits the source when the transform box is unset (montage cover-fill precondition)', () => {
    // The 1920×1030 call recording: without an explicit box it letterboxes —
    // exactly why the cover-fill transform (2013×1080) exists in the playbook.
    const rect = calculateMediaDrawDimensions(
      1920,
      1030,
      { x: 0, y: 0, width: 0, height: 0 },
      CANVAS,
    )
    const fitScale = Math.min(1920 / 1920, 1080 / 1030)
    expect(rect.width).toBeCloseTo(1920 * fitScale, 6)
    expect(rect.height).toBeCloseTo(1030 * fitScale, 6)
    expect(rect.x).toBeCloseTo((1920 - rect.width) / 2, 6)
    expect(rect.y).toBeCloseTo((1080 - rect.height) / 2, 6)
  })

  it('portrait source pillar-boxes horizontally', () => {
    const rect = calculateMediaDrawDimensions(
      1080,
      1920,
      { x: 0, y: 0, width: 0, height: 0 },
      CANVAS,
    )
    expect(rect.height).toBeCloseTo(1080, 6)
    expect(rect.width).toBeCloseTo(1080 * (1080 / 1920), 6)
    expect(rect.y).toBeCloseTo(0, 6)
  })
})

describe('calculateContainedMediaDrawLayout', () => {
  it('offsets the crop layout by the container top-left on canvas', () => {
    const { mediaRect, viewportRect } = calculateContainedMediaDrawLayout(
      1000,
      1000,
      { x: 0, y: 0, width: 500, height: 500 },
      CANVAS,
    )
    const containerLeft = 1920 / 2 - 250
    const containerTop = 1080 / 2 - 250
    // Square source in a square box: media fills the box, no letterbox.
    expect(mediaRect).toEqual({ x: containerLeft, y: containerTop, width: 500, height: 500 })
    expect(viewportRect.x).toBeCloseTo(containerLeft, 6)
    expect(viewportRect.width).toBeCloseTo(500, 6)
  })

  it('crop shrinks the viewport but leaves the media rect in place (in-place semantics)', () => {
    const { mediaRect, viewportRect } = calculateContainedMediaDrawLayout(
      1000,
      1000,
      { x: 0, y: 0, width: 500, height: 500 },
      CANVAS,
      { left: 0.2 },
    )
    expect(mediaRect.width).toBeCloseTo(500, 6)
    // 20% of the fitted 500px is cut from the left of the viewport.
    expect(viewportRect.x - mediaRect.x).toBeGreaterThanOrEqual(99) // pixel-rounded
    expect(viewportRect.width).toBeLessThanOrEqual(401)
  })
})

describe('hasCropFeather', () => {
  it('is true only when some edge has feather pixels', () => {
    expect(hasCropFeather({ left: 0, right: 0, top: 0, bottom: 0 })).toBe(false)
    expect(hasCropFeather({ left: 0, right: 2, top: 0, bottom: 0 })).toBe(true)
  })
})
