import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { HeadlessPlayer, type PlayerRef } from '@/runtime/player'
import { MainComposition } from '@/runtime/composition-runtime/compositions/main-composition'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { useMediaLibraryStore } from '@/runtime/composition-runtime/deps/stores'
import { usePlaybackStore } from '@/shared/state/playback'
import type { TimelineTrack, TimelineItem } from '@/types/timeline'
import type { CompositionInputProps } from '@/types/export'

interface BenchConfig {
  scenarioName: string
  startFrame: number
  durationFrames: number
  disableEffects?: boolean
  use1080pMedia?: boolean
  enableAudio?: boolean
}

interface BenchMetrics {
  scenario: string
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
  reactRendersCount: number
  zustandDispatchesCount: number
  hardSeeksCount: number
  rvfcCallbacksCount: number
  durationSec: number
}

const MEDIA_MAPPINGS: Record<string, string> = {
  'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c': '/test-media/screen_recording_3k.mov',
  'fe3a5597-09e7-4c17-b454-6b98820bc1c9': '/test-media/0406.mov',
  'a1371402-6588-443e-81a7-3cb3230db440': '/test-media/raw_speech_lecture.mp4',
}

const MEDIA_1080P_FALLBACK = '/test-media/standard_1080p30_60s.mp4'

function setupMediaLibrary() {
  for (const [id, url] of Object.entries(MEDIA_MAPPINGS)) {
    blobUrlManager.registerUrl(id, url)
  }
  blobUrlManager.registerUrl('standard-1080p', MEDIA_1080P_FALLBACK)

  useMediaLibraryStore.setState({
    mediaById: {
      'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c': {
        id: 'b235adc3-9b0e-4d3e-b96d-eaa2ed83917c',
        name: 'Screen Recording 2026-08-23 at 19.12.41.mov',
        type: 'video',
        width: 2940,
        height: 1912,
        fps: 30,
        duration: 5,
        videoCodec: 'h264',
        videoCodecSupported: true,
        blobUrl: '/test-media/screen_recording_3k.mov',
      } as any,
      'fe3a5597-09e7-4c17-b454-6b98820bc1c9': {
        id: 'fe3a5597-09e7-4c17-b454-6b98820bc1c9',
        name: '0406.mov',
        type: 'video',
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 44.6,
        videoCodec: 'hevc',
        videoCodecSupported: true,
        blobUrl: '/test-media/0406.mov',
      } as any,
      'a1371402-6588-443e-81a7-3cb3230db440': {
        id: 'a1371402-6588-443e-81a7-3cb3230db440',
        name: 'raw_speech_lecture.mp4',
        type: 'video',
        width: 1920,
        height: 1080,
        fps: 16,
        duration: 120,
        videoCodec: 'h264',
        videoCodecSupported: true,
        blobUrl: '/test-media/raw_speech_lecture.mp4',
      } as any,
    },
    mediaItems: [],
  })
}

export function Project1BenchApp() {
  const [projectData, setProjectData] = useState<any>(null)
  const [activeConfig, setActiveConfig] = useState<BenchConfig | null>(null)
  const [status, setStatus] = useState<string>('Loading project definition...')
  const [lastResults, setLastResults] = useState<BenchMetrics | null>(null)

  const playerRef = useRef<PlayerRef | null>(null)
  const renderCountRef = useRef<number>(0)
  const zustandDispatchesRef = useRef<number>(0)
  const metricsCollectorRef = useRef<{
    rafTimes: number[]
    frameNumbers: number[]
    longTasks: number[]
    driftSamples: number[]
    rvfcTimes: number[]
    hardSeeks: number
    observer?: PerformanceObserver
    running: boolean
  }>({
    rafTimes: [],
    frameNumbers: [],
    longTasks: [],
    driftSamples: [],
    rvfcTimes: [],
    hardSeeks: 0,
    running: false,
  })

  // Load project.json on mount
  useEffect(() => {
    setupMediaLibrary()
    fetch('/test-media/project1.json')
      .then((res) => res.json())
      .then((data) => {
        setProjectData(data)
        setStatus('Ready. Project 1 loaded.')
      })
      .catch((err) => {
        setStatus(`Failed to load project: ${err.message}`)
      })
  }, [])

  // Count renders
  renderCountRef.current += 1

  // Subscribe to Zustand updates
  useEffect(() => {
    const unsub = usePlaybackStore.subscribe(() => {
      zustandDispatchesRef.current += 1
    })
    return unsub
  }, [])

  // Build tracks with items
  const inputProps: CompositionInputProps | null = React.useMemo(() => {
    if (!projectData) return null

    const rawTracks: TimelineTrack[] = projectData.timeline.tracks || []
    let rawItems: TimelineItem[] = projectData.timeline.items || []

    // Adjust items based on activeConfig
    const transformedItems = rawItems.map((item) => {
      const cloned = JSON.parse(JSON.stringify(item))
      // Map src
      if (cloned.mediaId && MEDIA_MAPPINGS[cloned.mediaId]) {
        cloned.src = activeConfig?.use1080pMedia
          ? MEDIA_1080P_FALLBACK
          : MEDIA_MAPPINGS[cloned.mediaId]
      }
      if (activeConfig?.disableEffects) {
        cloned.effects = []
      }
      return cloned
    })

    const tracksWithItems: TimelineTrack[] = rawTracks.map((track) => ({
      ...track,
      items: transformedItems.filter((i) => i.trackId === track.id),
    }))

    return {
      fps: projectData.timeline.fps || 30,
      width: projectData.timeline.width || 1920,
      height: projectData.timeline.height || 1080,
      durationInFrames: projectData.timeline.durationInFrames || 5785,
      tracks: tracksWithItems,
      transitions: projectData.timeline.transitions || [],
      backgroundColor: '#000000',
    }
  }, [projectData, activeConfig])

  // Start benchmark scenario
  const runBenchmark = useCallback(
    async (config: BenchConfig): Promise<BenchMetrics> => {
      setStatus(`Preparing scenario: ${config.scenarioName}...`)
      setActiveConfig(config)
      renderCountRef.current = 0
      zustandDispatchesRef.current = 0

      const collector = metricsCollectorRef.current
      collector.rafTimes = []
      collector.frameNumbers = []
      collector.longTasks = []
      collector.driftSamples = []
      collector.rvfcTimes = []
      collector.hardSeeks = 0
      collector.running = false

      // Performance Observer for Long Tasks
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
        } catch {
          // Longtask might not be supported in WebKit
        }
      }

      // Wait a tick for React tree to mount
      await new Promise((resolve) => setTimeout(resolve, 400))

      const player = playerRef.current
      if (!player) {
        throw new Error('HeadlessPlayer ref is not available')
      }

      // Seek to start frame
      player.seekTo(config.startFrame)
      await new Promise((resolve) => setTimeout(resolve, 600))

      // Attach rVFC listener to active video elements
      const videoElements = Array.from(document.querySelectorAll('video'))
      for (const video of videoElements) {
        if ('requestVideoFrameCallback' in video) {
          const onFrame = (_now: number, _metadata: any) => {
            if (collector.running) {
              collector.rvfcTimes.push(performance.now())
              video.requestVideoFrameCallback(onFrame)
            }
          }
          video.requestVideoFrameCallback(onFrame)
        }
        video.addEventListener('seeking', () => {
          if (collector.running) {
            collector.hardSeeks += 1
          }
        })
      }

      setStatus(`Running playback for ${config.scenarioName} (${config.durationFrames} frames)...`)
      collector.running = true

      let rafId: number
      const onRaf = (ts: number) => {
        if (!collector.running) return
        collector.rafTimes.push(ts)
        const curFrame = player.getCurrentFrame()
        collector.frameNumbers.push(curFrame)

        // Measure A/V drift against video.currentTime
        const activeVideo = document.querySelector('video') as HTMLVideoElement | null
        if (activeVideo && !activeVideo.paused) {
          const expectedSec = curFrame / (inputProps?.fps || 30)
          const actualSec = activeVideo.currentTime
          const driftMs = Math.abs(expectedSec - actualSec) * 1000
          collector.driftSamples.push(driftMs)
        }

        rafId = requestAnimationFrame(onRaf)
      }

      const benchStartTime = performance.now()
      rafId = requestAnimationFrame(onRaf)
      player.play()

      // Calculate play duration in ms
      const targetDurationMs = (config.durationFrames / (inputProps?.fps || 30)) * 1000

      await new Promise((resolve) => setTimeout(resolve, targetDurationMs))

      player.pause()
      collector.running = false
      cancelAnimationFrame(rafId)
      collector.observer?.disconnect()

      const benchEndTime = performance.now()
      const totalDurationSec = (benchEndTime - benchStartTime) / 1000

      // Compute statistics
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

      const result: BenchMetrics = {
        scenario: config.scenarioName,
        targetFps: inputProps?.fps || 30,
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
        reactRendersCount: renderCountRef.current,
        zustandDispatchesCount: zustandDispatchesRef.current,
        hardSeeksCount: collector.hardSeeks,
        rvfcCallbacksCount: collector.rvfcTimes.length,
        durationSec: Number(totalDurationSec.toFixed(2)),
      }

      setLastResults(result)
      setStatus(`Completed scenario: ${config.scenarioName}`)
      return result
    },
    [inputProps],
  )

  // Expose global controller
  useEffect(() => {
    ;(window as any).__PROJECT1_BENCH__ = {
      runBenchmark,
      getResults: () => lastResults,
      getStatus: () => status,
    }
  }, [runBenchmark, lastResults, status])

  return (
    <div>
      <h2>SCLIP Project 1 Playback Profiler</h2>
      <p id="status-display">Status: {status}</p>

      <div className="preview-container">
        {inputProps && (
          <HeadlessPlayer
            ref={playerRef}
            durationInFrames={inputProps.durationInFrames || 5785}
            fps={inputProps.fps}
            initialFrame={activeConfig?.startFrame || 0}
            width={960}
            height={540}
            autoPlay={false}
            loop={false}
            layoutSize={{ width: 960, height: 540 }}
            style={{ width: '100%', height: '100%' }}
          >
            <MainComposition {...inputProps} />
          </HeadlessPlayer>
        )}
      </div>

      {lastResults && (
        <pre className="metrics-log" id="results-display">
          {JSON.stringify(lastResults, null, 2)}
        </pre>
      )}
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<Project1BenchApp />)
