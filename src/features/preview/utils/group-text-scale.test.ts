// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import type { TextItem, TimelineItem, VideoItem } from '@/types/timeline'
import type { Transform } from '../types/gizmo'
import { buildGroupScaledTextProperties } from './group-text-scale'

const transform = (width: number, height: number): Transform => ({
  x: 0,
  y: 0,
  width,
  height,
  rotation: 0,
  opacity: 1,
})

describe('group text scale', () => {
  it('scales text metrics while leaving video content on the transform path', () => {
    const text = {
      id: 'text-1',
      type: 'text',
      trackId: 'text-track',
      from: 0,
      durationInFrames: 90,
      label: 'Title',
      text: 'Title',
      color: '#ffffff',
      fontSize: 80,
      letterSpacing: 4,
      textPadding: 20,
      backgroundRadius: 12,
      textShadow: { offsetX: 2, offsetY: 6, blur: 10, color: '#000000' },
      stroke: { width: 2, color: '#000000' },
      textSpans: [{ text: 'Title', fontSize: 100, letterSpacing: 6 }],
    } as TextItem
    const video = {
      id: 'video-1',
      type: 'video',
      trackId: 'video-track',
      from: 0,
      durationInFrames: 90,
      label: 'Video',
      src: 'video.mp4',
    } as VideoItem
    const start = new Map<string, Transform>([
      [text.id, transform(400, 200)],
      [video.id, transform(1280, 720)],
    ])
    const next = new Map<string, Transform>([
      [text.id, transform(200, 100)],
      [video.id, transform(640, 360)],
    ])

    const updates = buildGroupScaledTextProperties([text, video] as TimelineItem[], start, next)

    expect(updates.has(video.id)).toBe(false)
    expect(updates.get(text.id)).toMatchObject({
      fontSize: 40,
      letterSpacing: 2,
      textPadding: 10,
      backgroundRadius: 6,
      textShadow: { offsetX: 1, offsetY: 3, blur: 5 },
      stroke: { width: 1 },
      textSpans: [{ fontSize: 50, letterSpacing: 3 }],
    })
  })

  it('materializes resolved defaults so unstyled text scales visually', () => {
    const text = {
      id: 'text-defaults',
      type: 'text',
      trackId: 'text-track',
      from: 0,
      durationInFrames: 90,
      label: 'Title',
      text: 'Title',
      color: '#ffffff',
    } as TextItem

    const updates = buildGroupScaledTextProperties(
      [text],
      new Map([[text.id, transform(300, 100)]]),
      new Map([[text.id, transform(450, 150)]]),
    )

    expect(updates.get(text.id)).toMatchObject({
      fontSize: 90,
      letterSpacing: 0,
      textPadding: 24,
      backgroundRadius: 0,
    })
  })
})
