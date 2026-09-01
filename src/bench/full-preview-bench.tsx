import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { VideoPreview } from '@/features/preview/components/video-preview'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { useMediaLibraryStore } from '@/runtime/composition-runtime/deps/stores'
import { usePlaybackStore } from '@/shared/state/playback'
import { useTimelineStore } from '@/features/timeline/stores/timeline-store'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store'
import { useKeyframesStore } from '@/features/timeline/stores/keyframes-store'
import { usePreviewBridgeStore } from '@/shared/state/preview-bridge'
import type { TimelineTrack, TimelineItem } from '@/types/timeline'

interface FullBenchConfig {
  scenarioName: string
  startFrame: number
  durationFrames: number
  disableEffects?: boolean
  use1080pMedia?: boolean
}

interface FullBenchMetrics {
  scenario: string
  engine?: string
  targetFps: number
  actualPreviewFps: number
  totalFramesExpected: number
  uniqueFramesPresented: number
  droppedFrames: number
  dropPercentage: number
  meanFrameIntervalMs: number
  p95FrameIntervalMs: number
  maxFrameIntervalMs: number
  frameJitterSpikesOver50ms: number
  frameJitterSpikesOver100ms: number
  longTasksCount: number
  totalBlockingTimeMs: number
  maxLongTaskMs: number
  longTasksList: number[]
  avDriftMaxMs: number
  avDriftAvgMs: number
  reactRendersPerSec: number
  zustandDispatchesPerSec: number
  hardSeeksCount: number
  rvfcCallbacksCount: number
  activeRenderSources: string[]
  durationSec: number
}

const MEDIA_MAPPINGS: Record<string, string> = {
  'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c': '/test-media/screen_recording_3k.mov',
  'fe3a5597-09e7-4c17-b454-6b98820bc1c9': '/test-media/0406.mov',
  'a1371402-6588-443e-81a7-3cb3230db440': '/test-media/raw_speech_lecture.mp4',
}

const MEDIA_1080P_FALLBACK = '/test-media/standard_1080p30_60s.mp4'

function initStores(project: any) {
  // 1. Media Library
  for (const [id, url] of Object.entries(MEDIA_MAPPINGS)) {
    blobUrlManager.registerUrl(id, url)
  }
  blobUrlManager.registerUrl('standard-1080p', MEDIA_1080P_FALLBACK)

  useMediaLibraryStore.setState({
    mediaById: {
      'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c': {
        id: 'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c',
        name: 'Screen Recording 2026-08-23 at 19.12.41.mov',
        fileName: 'Screen Recording 2026-08-23 at 19.12.41.mov',
        mimeType: 'video/quicktime',
        type: 'video',
        width: 2940,
        height: 1912,
        fps: 30,
        duration: 5,
        videoCodec: 'h264',
        audioCodec: 'aac',
        videoCodecSupported: true,
        blobUrl: '/test-media/screen_recording_3k.mov',
      } as any,
      'fe3a5597-09e7-4c17-b454-6b98820bc1c9': {
        id: 'fe3a5597-09e7-4c17-b454-6b98820bc1c9',
        name: '0406.mov',
        fileName: '0406.mov',
        mimeType: 'video/quicktime',
        type: 'video',
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 44.6,
        videoCodec: 'hevc',
        audioCodec: 'aac',
        videoCodecSupported: true,
        blobUrl: '/test-media/0406.mov',
      } as any,
      'a1371402-6588-443e-81a7-3cb3230db440': {
        id: 'a1371402-6588-443e-81a7-3cb3230db440',
        name: 'raw_speech_lecture.mp4',
        fileName: 'raw_speech_lecture.mp4',
        mimeType: 'video/mp4',
        type: 'video',
        width: 1920,
        height: 1080,
        fps: 16,
        duration: 120,
        videoCodec: 'h264',
        audioCodec: 'aac',
        videoCodecSupported: true,
        blobUrl: '/test-media/raw_speech_lecture.mp4',
      } as any,
    },
    mediaItems: [],
  })

  // 2. Timeline tracks & items
  const tracks: TimelineTrack[] = project.timeline.tracks || []
  const items: TimelineItem[] = (project.timeline.items || []).map((item: any) => {
    const cloned = JSON.parse(JSON.stringify(item))
    if (cloned.mediaId && MEDIA_MAPPINGS[cloned.mediaId]) {
      cloned.src = MEDIA_MAPPINGS[cloned.mediaId]
    }
    return cloned
  })

  useTimelineStore.setState({
    tracks,
    items,
    durationInFrames: project.timeline.durationInFrames || 5785,
    fps: project.timeline.fps || 30,
  })

  useItemsStore.setState({
    items,
  })

  useTransitionsStore.setState({
    transitions: project.timeline.transitions || [],
  })

  useKeyframesStore.setState({
    keyframes: project.timeline.keyframes || [],
  })

  usePlaybackStore.setState({
    currentFrame: 0,
    previewFrame: null,
    isPlaying: false,
    durationInFrames: project.timeline.durationInFrames || 5785,
  })
}

export function FullVideoPreviewBenchApp() {
  const [project, setProject] = useState<any>(null)
  const [status, setStatus] = useState('Initializing...')
  const [lastResults, setLastResults] = useState<FullBenchMetrics | null>(null)

  const renderCountRef = useRef(0)
  renderCountRef.current += 1

  const zustandDispatchesRef = useRef(0)

  const collectorRef = useRef<{
    rafTimes: number[]
    frameNumbers: number[]
    longTasks: number[]
    driftSamples: number[]
    rvfcTimes: number[]
    hardSeeks: number
    renderSources: Set<string>
    observer?: PerformanceObserver
    running: boolean
  }>({
    rafTimes: [],
    frameNumbers: [],
    longTasks: [],
    driftSamples: [],
    rvfcTimes: [],
    hardSeeks: 0,
    renderSources: new Set(),
    running: false,
  })

  useEffect(() => {
    fetch('/test-media/project1.json')
      .then((res) => res.json())
      .then((data) => {
        initStores(data)
        setProject(data)
        setStatus('Ready. Full VideoPreview initialized.')
      })
      .catch((err) => {
        setStatus(`Error loading project: ${err.message}`)
      })
  }, [])

  // Subscribe to Zustand updates
  useEffect(() => {
    const unsub = usePlaybackStore.subscribe(() => {
      zustandDispatchesRef.current += 1
    })
    return unsub
  }, [])

  const runBenchmark = useCallback(
    async (config: FullBenchConfig): Promise<FullBenchMetrics> => {
      setStatus(`Configuring scenario: ${config.scenarioName}...`)

      // Modify items if config overrides
      const baseItems = project.timeline.items.map((i: any) => {
        const cloned = JSON.parse(JSON.stringify(i))
        if (cloned.mediaId && MEDIA_MAPPINGS[cloned.mediaId]) {
          cloned.src = config.use1080pMedia
            ? MEDIA_1080P_FALLBACK
            : MEDIA_MAPPINGS[cloned.mediaId]
        }
        if (config.disableEffects) {
          cloned.effects = []
        }
        return cloned
      })

      useItemsStore.setState({ items: baseItems })
      useTimelineStore.setState({ items: baseItems })

      renderCountRef.current = 0
      zustandDispatchesRef.current = 0

      const collector = collectorRef.current
      collector.rafTimes = []
      collector.frameNumbers = []
      collector.longTasks = []
      collector.driftSamples = []
      collector.rvfcTimes = []
      collector.hardSeeks = 0
      collector.renderSources.clear()
      collector.running = false

      // PerformanceObserver for Long Tasks
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          collector.observer?.disconnect()
          collector.observer = new PerformanceObserver((list) => {
            if (!collector.running) return
            for (const entry of list.getEntries()) {
              if (entry.entryType === 'longtask') {
                collector.longTasks.push(entry.duration)
              }
            }
          })
          collector.observer.observe({ entryTypes: ['longtask'] })
        } catch {}
      }

      // Seek to start frame and settle
      usePlaybackStore.getState().setCurrentFrame(config.startFrame)
      await new Promise((r) => setTimeout(r, 600))

      // Attach rVFC and seek listeners
      const videoElements = Array.from(document.querySelectorAll('video'))
      for (const video of videoElements) {
        if ('requestVideoFrameCallback' in video) {
          const onFrame = () => {
            if (collector.running) {
              collector.rvfcTimes.push(performance.now())
              video.requestVideoFrameCallback(onFrame)
            }
          }
          video.requestVideoFrameCallback(onFrame)
        }
        video.addEventListener('seeking', () => {
          if (collector.running) collector.hardSeeks += 1
        })
      }

      // Subscribe to render source changes
      const canvasEl = document.querySelector('canvas')
      const checkSource = () => {
        if (!collector.running) return
        const fastScrubVisible = canvasEl && canvasEl.style.visibility === 'visible'
        collector.renderSources.add(fastScrubVisible ? 'fast_scrub_overlay' : 'dom_player')
      }

      setStatus(`Running full VideoPreview playback for ${config.scenarioName}...`)
      collector.running = true

      let rafId: number
      const fps = project.timeline.fps || 30
      const onRaf = (ts: number) => {
        if (!collector.running) return
        collector.rafTimes.push(ts)
        const curFrame = usePlaybackStore.getState().currentFrame
        collector.frameNumbers.push(curFrame)
        checkSource()

        // Calculate expected source time for current active video item
        const activeItem = baseItems.find(
          (item: any) =>
            item.type === 'video' &&
            curFrame >= item.from &&
            curFrame < item.from + item.durationInFrames,
        )
        if (activeItem) {
          const activeVideo = document.querySelector('video') as HTMLVideoElement | null
          if (activeVideo && !activeVideo.paused) {
            const relFrame = curFrame - activeItem.from
            const expectedSec = (activeItem.trimStart || 0) / (activeItem.sourceFps || fps) + relFrame / fps
            const actualSec = activeVideo.currentTime
            const driftMs = Math.abs(expectedSec - actualSec) * 1000
            collector.driftSamples.push(driftMs)
          }
        }

        rafId = requestAnimationFrame(onRaf)
      }

      const benchStartTime = performance.now()
      rafId = requestAnimationFrame(onRaf)

      // Start playback via store
      usePlaybackStore.getState().play()

      const targetDurationMs = (config.durationFrames / fps) * 1000
      await new Promise((r) => setTimeout(r, targetDurationMs))

      usePlaybackStore.getState().pause()
      collector.running = false
      cancelAnimationFrame(rafId)
      collector.observer?.disconnect()

      const benchEndTime = performance.now()
      const totalDurationSec = (benchEndTime - benchStartTime) / 1000

      // Stats
      const rafTimes = collector.rafTimes
      const intervals: number[] = []
      let jitterOver50 = 0
      let jitterOver100 = 0
      for (let i = 1; i < rafTimes.length; i++) {
        const dt = rafTimes[i] - rafTimes[i - 1]
        intervals.push(dt)
        if (dt > 50) jitterOver50 += 1
        if (dt > 100) jitterOver100 += 1
      }
      intervals.sort((a, b) => a - b)
      const meanInterval =
        intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
      const p95Interval =
        intervals.length > 0 ? intervals[Math.floor(intervals.length * 0.95)] : 0
      const maxInterval = intervals.length > 0 ? intervals[intervals.length - 1] : 0

      const uniqueFrames = new Set(collector.frameNumbers).size
      const expectedFrames = config.durationFrames
      const droppedFrames = Math.max(0, expectedFrames - uniqueFrames)
      const dropPercentage = (droppedFrames / expectedFrames) * 100
      const actualFps = uniqueFrames / totalDurationSec

      const totalTbt = collector.longTasks.reduce(
        (sum, dur) => sum + Math.max(0, dur - 50),
        0,
      )
      const maxLongTask = collector.longTasks.reduce((max, dur) => Math.max(max, dur), 0)

      const driftAvg =
        collector.driftSamples.length > 0
          ? collector.driftSamples.reduce((a, b) => a + b, 0) / collector.driftSamples.length
          : 0
      const driftMax =
        collector.driftSamples.length > 0 ? Math.max(...collector.driftSamples) : 0

      const results: FullBenchMetrics = {
        scenario: config.scenarioName,
        targetFps: fps,
        actualPreviewFps: Number(actualFps.toFixed(2)),
        totalFramesExpected: expectedFrames,
        uniqueFramesPresented: uniqueFrames,
        droppedFrames,
        dropPercentage: Number(dropPercentage.toFixed(2)),
        meanFrameIntervalMs: Number(meanInterval.toFixed(2)),
        p95FrameIntervalMs: Number(p95Interval.toFixed(2)),
        maxFrameIntervalMs: Number(maxInterval.toFixed(2)),
        frameJitterSpikesOver50ms: jitterOver50,
        frameJitterSpikesOver100ms: jitterOver100,
        longTasksCount: collector.longTasks.length,
        totalBlockingTimeMs: Number(totalTbt.toFixed(1)),
        maxLongTaskMs: Number(maxLongTask.toFixed(1)),
        longTasksList: collector.longTasks.map((t) => Number(t.toFixed(1))),
        avDriftMaxMs: Number(driftMax.toFixed(2)),
        avDriftAvgMs: Number(driftAvg.toFixed(2)),
        reactRendersPerSec: Number((renderCountRef.current / totalDurationSec).toFixed(1)),
        zustandDispatchesPerSec: Number(
          (zustandDispatchesRef.current / totalDurationSec).toFixed(1),
        ),
        hardSeeksCount: collector.hardSeeks,
        rvfcCallbacksCount: collector.rvfcTimes.length,
        activeRenderSources: Array.from(collector.renderSources),
        durationSec: Number(totalDurationSec.toFixed(2)),
      }

      setLastResults(results)
      setStatus(`Completed: ${config.scenarioName}`)
      return results
    },
    [project],
  )

  useEffect(() => {
    ;(window as any).__FULL_PREVIEW_BENCH__ = {
      runBenchmark,
      getResults: () => lastResults,
      getStatus: () => status,
    }
  }, [runBenchmark, lastResults, status])

  return (
    <div>
      <h2>Full VideoPreview Benchmark Stage</h2>
      <p id="bench-status">Status: {status}</p>
      <div className="preview-stage-wrap">
        {project && (
          <VideoPreview
            project={{
              width: project.timeline.width || 1920,
              height: project.timeline.height || 1080,
              backgroundColor: project.timeline.backgroundColor || '#000000',
            }}
            containerSize={{ width: 960, height: 540 }}
            chrome="edit"
          />
        )}
      </div>
      {lastResults && (
        <pre className="metrics-log" id="bench-results">
          {JSON.stringify(lastResults, null, 2)}
        </pre>
      )}
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<FullVideoPreviewBenchApp />)
