// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  getPreviewPlaybackAcceptanceSummary,
  getPreviewNativePlaybackForensicsReport,
  recordPreviewCompositionRender,
  recordPreviewPlaybackHardSeek,
  recordPreviewPlaybackVideoFrame,
  recordPreviewScrubPresentationQuality,
  recordPreviewScrubRequest,
  recordPreviewTimelineClockTrace,
  recordPreviewVideoSource,
} from './preview-scrub-performance'

type PerformanceState = {
  fallbacks: Array<{
    seq: number
    workspace: string
    frame: number
    firstVisibleMs: number
    exactReplacementMs: number | null
  }>
  timelineClockTrace: Array<{ kind: string; atMs: number; dateMs: number }>
  reset: () => void
}

function getState(): PerformanceState {
  return (globalThis as typeof globalThis & { __PREVIEW_SCRUB_PERF__: PerformanceState })
    .__PREVIEW_SCRUB_PERF__
}

beforeEach(() => getState().reset())

describe('preview scrub fallback performance', () => {
  it('tracks first fallback visibility and later exact-frame replacement latency', () => {
    recordPreviewScrubRequest('color', 120, 1)
    recordPreviewScrubPresentationQuality(120, true)

    expect(getState().fallbacks).toHaveLength(1)
    expect(getState().fallbacks[0]).toMatchObject({
      seq: 1,
      workspace: 'color',
      frame: 120,
      exactReplacementMs: null,
    })

    recordPreviewScrubPresentationQuality(120, false)
    expect(getState().fallbacks[0]!.exactReplacementMs).toEqual(expect.any(Number))
  })

  it('does not attach an exact replacement to a superseded fallback request', () => {
    recordPreviewScrubRequest('color', 120, 1)
    recordPreviewScrubPresentationQuality(120, true)
    recordPreviewScrubRequest('color', 121, 1)
    recordPreviewScrubPresentationQuality(121, true)
    recordPreviewScrubPresentationQuality(120, false)

    expect(getState().fallbacks).toEqual([
      expect.objectContaining({ frame: 120, exactReplacementMs: null }),
      expect.objectContaining({ frame: 121, exactReplacementMs: null }),
    ])
  })

  it('keeps the handoff open for a pointer-up request on the same frame', () => {
    recordPreviewScrubRequest('animate', 240, 1)
    recordPreviewScrubPresentationQuality(240, true)
    recordPreviewScrubRequest('animate', 240, 0)
    recordPreviewScrubPresentationQuality(240, false)

    expect(getState().fallbacks).toHaveLength(1)
    expect(getState().fallbacks[0]!.exactReplacementMs).toEqual(expect.any(Number))
  })

  it('summarizes live DOM playback separately from software extraction', () => {
    recordPreviewCompositionRender({ frame: 1, path: 'direct', ms: 10 })
    recordPreviewCompositionRender({ frame: 2, path: 'full', ms: 20 })
    recordPreviewVideoSource({ frame: 1, itemId: 'clip', path: 'dom-video', sourceTime: 0 })
    recordPreviewVideoSource({ frame: 2, itemId: 'clip', path: 'dom-video', sourceTime: 1 / 30 })
    recordPreviewVideoSource({ frame: 3, itemId: 'clip', path: 'mediabunny', sourceTime: 2 / 30 })
    recordPreviewPlaybackVideoFrame({
      itemId: 'clip',
      currentTime: 0,
      targetTime: 0,
      presentedFrames: 10,
    })
    recordPreviewPlaybackVideoFrame({
      itemId: 'clip',
      currentTime: 0.1,
      targetTime: 1 / 30,
      presentedFrames: 13,
    })
    recordPreviewPlaybackHardSeek('clip')

    expect(getPreviewPlaybackAcceptanceSummary()).toEqual({
      renderedEffectFrames: 2,
      domVideoSourceFrames: 2,
      mediaBunnySourceFrames: 1,
      effectRenderAvgMs: 15,
      effectRenderP95Ms: 20,
      effectRenderMaxMs: 20,
      presentedVideoFrames: 2,
      droppedVideoFrames: 2,
      avDriftAvgMs: expect.any(Number),
      avDriftMaxMs: expect.any(Number),
      hardSeeks: 1,
    })
  })

  it('exports bounded clock scheduler evidence alongside native media evidence', () => {
    recordPreviewTimelineClockTrace({
      kind: 'clock-control',
      action: 'play',
      timelineFrame: 64,
      timelineTime: 64 / 30,
      isPlaying: true,
      atMs: 100,
      dateMs: 1_700_000_000_000,
    })
    recordPreviewTimelineClockTrace({
      kind: 'watchdog',
      timelineFrame: 64,
      timelineTime: 64 / 30,
      isPlaying: true,
      watchdogGapMs: 250,
      latestClockAtMs: 100,
      atMs: 350,
      dateMs: 1_700_000_000_250,
    })

    expect(getState().timelineClockTrace).toHaveLength(2)
    expect(getPreviewNativePlaybackForensicsReport()?.timelineClockTrace).toEqual([
      expect.objectContaining({ kind: 'clock-control', action: 'play', atMs: 100 }),
      expect.objectContaining({ kind: 'watchdog', watchdogGapMs: 250, latestClockAtMs: 100 }),
    ])
  })
})
