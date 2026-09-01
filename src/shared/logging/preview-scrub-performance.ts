export type PreviewScrubWorkspace = 'edit' | 'color' | 'animate' | 'motion'

export interface PreviewScrubRequestSample {
  seq: number
  workspace: PreviewScrubWorkspace
  frame: number
  direction: -1 | 0 | 1
  atMs: number
}

export interface PreviewCompositionRenderSample {
  frame: number
  path: 'cache-hit' | 'direct' | 'full' | 'aborted'
  ms: number
  planMs?: number
  taskMs?: number
  gpuWaitMs?: number
  compositeMs?: number
  finalizeMs?: number
  taskCount?: number
  transitionCount?: number
  slowTasks?: Array<{
    id: string
    kind: string
    ms: number
  }>
}

export interface PreviewScrubPresentedSample {
  seq: number
  workspace: PreviewScrubWorkspace
  requestedFrame: number
  renderedFrame: number
  direction: -1 | 0 | 1
  requestToDequeueMs: number
  requestToRenderStartMs: number
  requestToPresentMs: number
  renderMs: number
  supersededByRequests: number
}

export interface PreviewScrubFallbackSample {
  seq: number
  workspace: PreviewScrubWorkspace
  frame: number
  firstVisibleMs: number
  exactReplacementMs: number | null
}

export interface PreviewVideoSourceSample {
  frame: number
  itemId: string
  path:
    | 'dom-video'
    | 'worker-bitmap'
    | 'proxy-fallback'
    | 'tier2-cache'
    | 'mediabunny'
    | 'video-fallback'
  sourceTime: number
  domAvailable?: boolean
  domReady?: boolean
  domDrift?: number | null
  canUseDom?: boolean
}

/** A decoded frame that the browser has actually presented from a preview video element. */
export interface PreviewPlaybackVideoFrameSample {
  itemId: string
  currentTime: number
  targetTime: number
  presentedFrames: number | null
  atMs: number
}

export interface PreviewPlaybackHardSeekSample {
  itemId: string
  atMs: number
}

export interface PreviewPlaybackAcceptanceSummary {
  renderedEffectFrames: number
  domVideoSourceFrames: number
  mediaBunnySourceFrames: number
  effectRenderAvgMs: number | null
  effectRenderP95Ms: number | null
  effectRenderMaxMs: number | null
  presentedVideoFrames: number
  droppedVideoFrames: number
  avDriftAvgMs: number | null
  avDriftMaxMs: number | null
  hardSeeks: number
}

/**
 * A bounded, real-WebView trace of the native media control loop.  Times are
 * deliberately expressed in the media source's time domain: `expectedSourceTime`
 * is the same mapping used to drive the individual element, never raw timeline
 * time compared directly with `currentTime`.
 */
export interface PreviewNativePlaybackTraceEntry {
  kind: 'sample' | 'event'
  stream: 'video' | 'audio'
  event?: string
  atMs: number
  itemId: string
  mediaId?: string
  timelineFrame: number
  timelineTime: number
  sequenceFrom: number
  sequenceFrame: number
  sequenceFrameOffset: number
  itemFromFrame: number
  durationInFrames?: number
  sourceStartFrame: number
  sourceFps: number
  nominalPlaybackRate: number
  expectedSourceTime: number
  mediaTime: number
  mappedDriftMs: number
  paused: boolean
  elementPlaybackRate: number
  readyState: number
  networkState: number
  seeking: boolean
  ended: boolean
  currentSrc: string
  videoWidth?: number
  videoHeight?: number
  presentedFrames?: number | null
  presentationMediaTime?: number | null
  presentationGapMs?: number | null
  correction?: 'seek' | 'adjust_rate' | 'nominal_rate' | 'none'
  correctionRate?: number
  correctionSeekTo?: number
  correctionReason?: string
  lastSeekReason?: string | null
  postSeekGrace: boolean
  audioContextState?: AudioContextState | null
}

export interface PreviewNativePlaybackForensicsReport {
  acceptance: PreviewPlaybackAcceptanceSummary
  trace: PreviewNativePlaybackTraceEntry[]
  /** Bounded timing evidence from the player Clock, its RAF loop, and an independent watchdog. */
  timelineClockTrace: PreviewTimelineClockTraceEntry[]
  /** Audio minus video source time for nearest same-media samples (positive = audio ahead). */
  audioVideoPairs: Array<{
    mediaId: string
    atMs: number
    audioItemId: string
    videoItemId: string
    audioMinusVideoMs: number
    expectedDifferenceMs: number
  }>
}

/**
 * A bounded forensic record for the timeline clock. Unlike native media
 * samples, these entries deliberately identify which scheduling source did
 * (or did not) run: Clock RAF, an independent timer, browser lifecycle, or
 * the Long Task API.
 */
export interface PreviewTimelineClockTraceEntry {
  kind: 'clock-raf' | 'clock-control' | 'clock-lifecycle' | 'watchdog' | 'long-task'
  atMs: number
  performanceNowMs: number
  dateMs: number
  action?: string
  timelineFrame?: number
  timelineTime?: number
  isPlaying?: boolean
  paused?: boolean
  playbackRate?: number
  animationLoopRunning?: boolean
  clockSource?: 'audio-context' | 'performance'
  clockNowMs?: number | null
  sourceNowMs?: number | null
  audioContextState?: AudioContextState | null
  rafTimestampMs?: number
  rafCallbackCount?: number
  rafGapMs?: number | null
  frameDelta?: number
  wallDeltaMs?: number | null
  watchdogTickCount?: number
  watchdogGapMs?: number | null
  latestClockAtMs?: number | null
  visibilityState?: DocumentVisibilityState | null
  documentHidden?: boolean | null
  hasFocus?: boolean | null
  longTaskStartMs?: number
  longTaskDurationMs?: number
}

export interface PreviewPreseekPlanSample {
  frame: number
  sourceCount: number
  timestampCount: number
  atMs: number
}

export interface PreviewCanvasPoolSample {
  width: number
  height: number
  maxSize: number
  peakInUse: number
  temporaryAllocations: number
}

export interface PreviewDecoderMetricsSample {
  requests: number
  cacheHits: number
  workerPosts: number
  workerSuccesses: number
  workerFailures: number
  supersededRequests: number
  cacheSources: number
  cacheBitmaps: number
  cacheSourceEvictions: number
  activeRequests: number
  activeCacheHits: number
  activeWorkerPosts: number
  activeCancellations: number
  activeSupersededRequests: number
  activeLookaheadPosts: number
  activeExtractorCount: number
  activeExtractorPeak: number
  activeReadyNotifications: number
  fallbackRequests: number
  fallbackCacheHits: number
  fallbackBitmaps: number
  fallbackSourceEvictions: number
  fallbackReadyNotifications: number
  exactFallbackReplacements: number
}

export interface PreviewScrubPerformanceState {
  version: 1
  requests: PreviewScrubRequestSample[]
  renders: PreviewCompositionRenderSample[]
  presented: PreviewScrubPresentedSample[]
  fallbacks: PreviewScrubFallbackSample[]
  videoSources: PreviewVideoSourceSample[]
  playbackVideoFrames: PreviewPlaybackVideoFrameSample[]
  playbackHardSeeks: PreviewPlaybackHardSeekSample[]
  nativePlaybackTrace: PreviewNativePlaybackTraceEntry[]
  timelineClockTrace: PreviewTimelineClockTraceEntry[]
  preseeks: PreviewPreseekPlanSample[]
  canvasPools: PreviewCanvasPoolSample[]
  decoder: PreviewDecoderMetricsSample | null
  reset: () => void
}

type PreviewScrubPerformanceGlobal = typeof globalThis & {
  __PREVIEW_SCRUB_PERF__?: PreviewScrubPerformanceState
}

type PendingRequest = PreviewScrubRequestSample

interface CompletedRender {
  request: PendingRequest
  dequeuedAtMs: number
  renderStartedAtMs: number
  renderEndedAtMs: number
}

// This explicit build flag produces a normal production bundle with only the
// bounded playback collector enabled. It intentionally does not alter media
// transport or synchronization behavior.
const SHOULD_PROFILE_PREVIEW_SCRUB = true
const MAX_PERF_SAMPLES = 3000
const PERF_SNAPSHOT_ELEMENT_ID = 'freecut-preview-scrub-performance'
const PERF_SNAPSHOT_DEBOUNCE_MS = 100

let requestSequence = 0
let latestRequest: PendingRequest | null = null
const pendingRequestsByFrame = new Map<number, PendingRequest>()
const completedRendersByFrame = new Map<number, CompletedRender>()
const fallbackPresentationByFrame = new Map<
  number,
  { sample: PreviewScrubFallbackSample; presentedAtMs: number }
>()
let snapshotTimer: ReturnType<typeof setTimeout> | null = null
let maxCanvasPoolPeak = 0
let maxCanvasPoolTemporaryAllocations = 0
const lastNativeSampleAtByStream = new Map<string, number>()
const TIMELINE_CLOCK_SAMPLE_INTERVAL_MS = 125
const TIMELINE_CLOCK_WATCHDOG_INTERVAL_MS = 250
let lastTimelineClockRafSampleAtMs: number | null = null
let lastTimelineWatchdogAtMs: number | null = null
let timelineWatchdogTickCount = 0
let latestTimelineClockEntry: PreviewTimelineClockTraceEntry | null = null
let timelineClockEnvironmentInstalled = false

function pushBounded<T>(samples: T[], sample: T): void {
  samples.push(sample)
  if (samples.length > MAX_PERF_SAMPLES) samples.shift()
}

function resetInternalState(): void {
  requestSequence = 0
  latestRequest = null
  pendingRequestsByFrame.clear()
  completedRendersByFrame.clear()
  fallbackPresentationByFrame.clear()
  maxCanvasPoolPeak = 0
  maxCanvasPoolTemporaryAllocations = 0
  lastNativeSampleAtByStream.clear()
  lastTimelineClockRafSampleAtMs = null
  lastTimelineWatchdogAtMs = null
  timelineWatchdogTickCount = 0
  latestTimelineClockEntry = null
}

function scheduleDomSnapshot(state: PreviewScrubPerformanceState): void {
  if (typeof document === 'undefined' || snapshotTimer !== null) return
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    let snapshot = document.getElementById(PERF_SNAPSHOT_ELEMENT_ID)
    if (!snapshot) {
      snapshot = document.createElement('script')
      snapshot.id = PERF_SNAPSHOT_ELEMENT_ID
      snapshot.setAttribute('type', 'application/json')
      snapshot.hidden = true
      document.documentElement.append(snapshot)
    }
    snapshot.textContent = JSON.stringify({
      version: state.version,
      requests: state.requests,
      renders: state.renders,
      presented: state.presented,
      fallbacks: state.fallbacks,
      videoSources: state.videoSources,
      playbackVideoFrames: state.playbackVideoFrames,
      playbackHardSeeks: state.playbackHardSeeks,
      nativePlaybackTrace: state.nativePlaybackTrace,
      timelineClockTrace: state.timelineClockTrace,
      preseeks: state.preseeks,
      canvasPools: state.canvasPools,
      decoder: state.decoder,
    })
  }, PERF_SNAPSHOT_DEBOUNCE_MS)
}

function createPerformanceState(): PreviewScrubPerformanceState {
  const state: PreviewScrubPerformanceState = {
    version: 1,
    requests: [],
    renders: [],
    presented: [],
    fallbacks: [],
    videoSources: [],
    playbackVideoFrames: [],
    playbackHardSeeks: [],
    nativePlaybackTrace: [],
    timelineClockTrace: [],
    preseeks: [],
    canvasPools: [],
    decoder: null,
    reset: () => {
      state.requests.length = 0
      state.renders.length = 0
      state.presented.length = 0
      state.fallbacks.length = 0
      state.videoSources.length = 0
      state.playbackVideoFrames.length = 0
      state.playbackHardSeeks.length = 0
      state.nativePlaybackTrace.length = 0
      state.timelineClockTrace.length = 0
      state.preseeks.length = 0
      state.canvasPools.length = 0
      state.decoder = null
      resetInternalState()
      scheduleDomSnapshot(state)
    },
  }
  return state
}

function getPerformanceState(): PreviewScrubPerformanceState | null {
  if (!SHOULD_PROFILE_PREVIEW_SCRUB) return null
  const root = globalThis as PreviewScrubPerformanceGlobal
  if (root.__PREVIEW_SCRUB_PERF__) {
    installTimelineClockEnvironmentDiagnostics()
    return root.__PREVIEW_SCRUB_PERF__
  }

  try {
    root.__PREVIEW_SCRUB_PERF__ = createPerformanceState()
    installTimelineClockEnvironmentDiagnostics()
    return root.__PREVIEW_SCRUB_PERF__
  } catch {
    // Some embedded runtimes make their global object non-extensible. The
    // profiler is diagnostic-only, so preview rendering must keep working.
    return null
  }
}

function getTimelineClockEnvironment(): Pick<
  PreviewTimelineClockTraceEntry,
  'visibilityState' | 'documentHidden' | 'hasFocus'
> {
  if (typeof document === 'undefined') {
    return { visibilityState: null, documentHidden: null, hasFocus: null }
  }
  return {
    visibilityState: document.visibilityState,
    documentHidden: document.hidden,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
  }
}

function installTimelineClockEnvironmentDiagnostics(): void {
  if (
    timelineClockEnvironmentInstalled ||
    !SHOULD_PROFILE_PREVIEW_SCRUB ||
    typeof window === 'undefined'
  ) {
    return
  }
  timelineClockEnvironmentInstalled = true

  const recordLifecycle = (action: string) => {
    recordPreviewTimelineClockTrace({
      kind: 'clock-lifecycle',
      action,
      ...getTimelineClockEnvironment(),
    })
  }
  document.addEventListener('visibilitychange', () => recordLifecycle('visibilitychange'))
  window.addEventListener('pagehide', () => recordLifecycle('pagehide'))
  window.addEventListener('pageshow', () => recordLifecycle('pageshow'))
  window.addEventListener('focus', () => recordLifecycle('focus'))
  window.addEventListener('blur', () => recordLifecycle('blur'))

  window.setInterval(() => {
    const latest = latestTimelineClockEntry
    if (!latest?.isPlaying) return
    const atMs = performance.now()
    const watchdogGapMs =
      lastTimelineWatchdogAtMs === null ? null : atMs - lastTimelineWatchdogAtMs
    lastTimelineWatchdogAtMs = atMs
    timelineWatchdogTickCount += 1
    recordPreviewTimelineClockTrace({
      kind: 'watchdog',
      timelineFrame: latest.timelineFrame,
      timelineTime: latest.timelineTime,
      isPlaying: latest.isPlaying,
      paused: latest.paused,
      playbackRate: latest.playbackRate,
      animationLoopRunning: latest.animationLoopRunning,
      clockSource: latest.clockSource,
      clockNowMs: latest.clockNowMs,
      sourceNowMs: latest.sourceNowMs,
      audioContextState: latest.audioContextState,
      watchdogTickCount: timelineWatchdogTickCount,
      watchdogGapMs,
      latestClockAtMs: latest.atMs,
      ...getTimelineClockEnvironment(),
    })
  }, TIMELINE_CLOCK_WATCHDOG_INTERVAL_MS)

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          recordPreviewTimelineClockTrace({
            kind: 'long-task',
            longTaskStartMs: entry.startTime,
            longTaskDurationMs: entry.duration,
            ...getTimelineClockEnvironment(),
          })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // Long Task reporting is not available in every WebView. The remaining
      // independent clock evidence still distinguishes scheduler loss.
    }
  }
}

/**
 * Record an independent piece of timeline-clock evidence. Clock RAF samples
 * are capped at 8Hz except when a cadence gap is observed; lifecycle/control
 * events are always retained.
 */
export function recordPreviewTimelineClockTrace(
  entry: Omit<PreviewTimelineClockTraceEntry, 'atMs' | 'performanceNowMs' | 'dateMs'> & {
    atMs?: number
    performanceNowMs?: number
    dateMs?: number
  },
): void {
  const state = getPerformanceState()
  if (!state) return
  const atMs = entry.atMs ?? performance.now()
  if (entry.kind === 'clock-raf') {
    const isCadenceGap = (entry.rafGapMs ?? 0) >= TIMELINE_CLOCK_SAMPLE_INTERVAL_MS * 2
    if (
      !isCadenceGap &&
      lastTimelineClockRafSampleAtMs !== null &&
      atMs - lastTimelineClockRafSampleAtMs < TIMELINE_CLOCK_SAMPLE_INTERVAL_MS
    ) {
      latestTimelineClockEntry = {
        ...entry,
        atMs,
        performanceNowMs: entry.performanceNowMs ?? atMs,
        dateMs: entry.dateMs ?? Date.now(),
      }
      return
    }
    lastTimelineClockRafSampleAtMs = atMs
  }
  const sample: PreviewTimelineClockTraceEntry = {
    ...entry,
    atMs,
    performanceNowMs: entry.performanceNowMs ?? atMs,
    dateMs: entry.dateMs ?? Date.now(),
  }
  if (entry.kind === 'clock-raf' || entry.kind === 'clock-control') {
    latestTimelineClockEntry = sample
  }
  pushBounded(state.timelineClockTrace, sample)
  scheduleDomSnapshot(state)
}

export function recordPreviewScrubRequest(
  workspace: PreviewScrubWorkspace,
  frame: number,
  direction: -1 | 0 | 1,
): void {
  const state = getPerformanceState()
  if (!state) return

  // A new pointer target supersedes every outstanding fallback handoff. Exact
  // frames that arrive for an older target must not be attributed to this
  // request, including when the user later revisits the same frame.
  for (const pendingFrame of fallbackPresentationByFrame.keys()) {
    if (pendingFrame !== frame) fallbackPresentationByFrame.delete(pendingFrame)
  }

  const request: PendingRequest = {
    seq: ++requestSequence,
    workspace,
    frame,
    direction,
    atMs: performance.now(),
  }
  latestRequest = request
  pendingRequestsByFrame.set(frame, request)
  pushBounded(state.requests, request)
  scheduleDomSnapshot(state)
}

export function recordPreviewScrubRenderDequeued(frame: number): void {
  if (!SHOULD_PROFILE_PREVIEW_SCRUB) return
  const request = pendingRequestsByFrame.get(frame)
  if (!request) return
  completedRendersByFrame.set(frame, {
    request,
    dequeuedAtMs: performance.now(),
    renderStartedAtMs: 0,
    renderEndedAtMs: 0,
  })
}

export function recordPreviewScrubRenderStarted(frame: number): void {
  const render = completedRendersByFrame.get(frame)
  if (render) render.renderStartedAtMs = performance.now()
}

export function recordPreviewScrubRenderCompleted(frame: number): void {
  const render = completedRendersByFrame.get(frame)
  if (render) render.renderEndedAtMs = performance.now()
}

export function recordPreviewScrubPresented(frame: number): void {
  const state = getPerformanceState()
  const render = completedRendersByFrame.get(frame)
  if (!state || !render || render.renderStartedAtMs === 0 || render.renderEndedAtMs === 0) return

  const presentedAtMs = performance.now()
  pushBounded(state.presented, {
    seq: render.request.seq,
    workspace: render.request.workspace,
    requestedFrame: render.request.frame,
    renderedFrame: frame,
    direction: render.request.direction,
    requestToDequeueMs: Number((render.dequeuedAtMs - render.request.atMs).toFixed(2)),
    requestToRenderStartMs: Number((render.renderStartedAtMs - render.request.atMs).toFixed(2)),
    requestToPresentMs: Number((presentedAtMs - render.request.atMs).toFixed(2)),
    renderMs: Number((render.renderEndedAtMs - render.renderStartedAtMs).toFixed(2)),
    supersededByRequests: Math.max(
      0,
      (latestRequest?.seq ?? render.request.seq) - render.request.seq,
    ),
  })
  completedRendersByFrame.delete(frame)
  if (pendingRequestsByFrame.get(frame)?.seq === render.request.seq) {
    pendingRequestsByFrame.delete(frame)
  }
  scheduleDomSnapshot(state)
}

export function recordPreviewScrubPresentationQuality(frame: number, usedFallback: boolean): void {
  const state = getPerformanceState()
  if (!state) return
  const now = performance.now()
  if (usedFallback) {
    const request = pendingRequestsByFrame.get(frame)
    if (!request || fallbackPresentationByFrame.has(frame)) return
    const sample: PreviewScrubFallbackSample = {
      seq: request.seq,
      workspace: request.workspace,
      frame,
      firstVisibleMs: Number((now - request.atMs).toFixed(2)),
      exactReplacementMs: null,
    }
    fallbackPresentationByFrame.set(frame, { sample, presentedAtMs: now })
    pushBounded(state.fallbacks, sample)
    scheduleDomSnapshot(state)
    return
  }

  const pendingFallback = fallbackPresentationByFrame.get(frame)
  if (!pendingFallback) return
  pendingFallback.sample.exactReplacementMs = Number(
    (now - pendingFallback.presentedAtMs).toFixed(2),
  )
  fallbackPresentationByFrame.delete(frame)
  scheduleDomSnapshot(state)
}

export function recordPreviewCompositionRender(sample: PreviewCompositionRenderSample): void {
  const state = getPerformanceState()
  if (!state) return
  pushBounded(state.renders, sample)
  scheduleDomSnapshot(state)
}

export function recordPreviewVideoSource(sample: PreviewVideoSourceSample): void {
  const state = getPerformanceState()
  if (!state) return
  pushBounded(state.videoSources, sample)
  scheduleDomSnapshot(state)
}

export function recordPreviewPlaybackVideoFrame(
  sample: Omit<PreviewPlaybackVideoFrameSample, 'atMs'> & { atMs?: number },
): void {
  const state = getPerformanceState()
  if (!state) return
  pushBounded(state.playbackVideoFrames, {
    ...sample,
    atMs: sample.atMs ?? performance.now(),
  })
  scheduleDomSnapshot(state)
}

export function recordPreviewPlaybackHardSeek(itemId: string): void {
  const state = getPerformanceState()
  if (!state) return
  pushBounded(state.playbackHardSeeks, { itemId, atMs: performance.now() })
  scheduleDomSnapshot(state)
}

/** Record native media state at <=8Hz per active element, plus all lifecycle events. */
export function recordPreviewNativePlaybackTrace(
  entry: Omit<PreviewNativePlaybackTraceEntry, 'atMs'> & { atMs?: number },
): void {
  const state = getPerformanceState()
  if (!state) return
  const atMs = entry.atMs ?? performance.now()
  if (entry.kind === 'sample') {
    const key = `${entry.stream}:${entry.itemId}`
    const previous = lastNativeSampleAtByStream.get(key)
    if (previous !== undefined && atMs - previous < 125) return
    lastNativeSampleAtByStream.set(key, atMs)
  }
  pushBounded(state.nativePlaybackTrace, { ...entry, atMs })
  scheduleDomSnapshot(state)
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null
}

/**
 * A compact, serializable report for a steady-state forward-playback run.
 * Available only in dev/perf builds, so it adds no production instrumentation.
 */
export function getPreviewPlaybackAcceptanceSummary(): PreviewPlaybackAcceptanceSummary | null {
  const state = getPerformanceState()
  if (!state) return null

  const effectRenderCosts = state.renders
    .filter((render) => render.path === 'direct' || render.path === 'full')
    .map((render) => render.ms)
  const driftMs = state.playbackVideoFrames.map((sample) =>
    Math.abs(sample.currentTime - sample.targetTime) * 1000,
  )
  const presentedFramesByItem = new Map<string, number>()
  let droppedVideoFrames = 0
  for (const sample of state.playbackVideoFrames) {
    if (sample.presentedFrames === null) continue
    const previous = presentedFramesByItem.get(sample.itemId)
    if (previous !== undefined && sample.presentedFrames > previous + 1) {
      droppedVideoFrames += sample.presentedFrames - previous - 1
    }
    presentedFramesByItem.set(sample.itemId, sample.presentedFrames)
  }

  return {
    renderedEffectFrames: effectRenderCosts.length,
    domVideoSourceFrames: state.videoSources.filter((sample) => sample.path === 'dom-video').length,
    mediaBunnySourceFrames: state.videoSources.filter((sample) => sample.path === 'mediabunny')
      .length,
    effectRenderAvgMs:
      effectRenderCosts.length > 0
        ? effectRenderCosts.reduce((sum, value) => sum + value, 0) / effectRenderCosts.length
        : null,
    effectRenderP95Ms: percentile95(effectRenderCosts),
    effectRenderMaxMs: effectRenderCosts.length > 0 ? Math.max(...effectRenderCosts) : null,
    presentedVideoFrames: state.playbackVideoFrames.length,
    droppedVideoFrames,
    avDriftAvgMs:
      driftMs.length > 0 ? driftMs.reduce((sum, value) => sum + value, 0) / driftMs.length : null,
    avDriftMaxMs: driftMs.length > 0 ? Math.max(...driftMs) : null,
    hardSeeks: state.playbackHardSeeks.length,
  }
}

export function getPreviewNativePlaybackForensicsReport(): PreviewNativePlaybackForensicsReport | null {
  const state = getPerformanceState()
  const acceptance = getPreviewPlaybackAcceptanceSummary()
  if (!state || !acceptance) return null
  const trace = [...state.nativePlaybackTrace]
  const videos = trace.filter((entry) => entry.kind === 'sample' && entry.stream === 'video')
  const audio = trace.filter((entry) => entry.kind === 'sample' && entry.stream === 'audio')
  const audioVideoPairs: PreviewNativePlaybackForensicsReport['audioVideoPairs'] = []
  for (const audioEntry of audio) {
    if (!audioEntry.mediaId) continue
    let nearest: PreviewNativePlaybackTraceEntry | null = null
    let nearestDistance = Infinity
    for (const videoEntry of videos) {
      if (videoEntry.mediaId !== audioEntry.mediaId) continue
      const distance = Math.abs(videoEntry.atMs - audioEntry.atMs)
      if (distance < nearestDistance) {
        nearest = videoEntry
        nearestDistance = distance
      }
    }
    if (!nearest || nearestDistance > 200) continue
    audioVideoPairs.push({
      mediaId: audioEntry.mediaId,
      atMs: audioEntry.atMs,
      audioItemId: audioEntry.itemId,
      videoItemId: nearest.itemId,
      audioMinusVideoMs: (audioEntry.mediaTime - nearest.mediaTime) * 1000,
      expectedDifferenceMs: (audioEntry.expectedSourceTime - nearest.expectedSourceTime) * 1000,
    })
  }
  return {
    acceptance,
    trace,
    timelineClockTrace: [...state.timelineClockTrace],
    audioVideoPairs,
  }
}

export function recordPreviewPreseekPlan(frame: number, bySource: Map<string, number[]>): void {
  const state = getPerformanceState()
  if (!state) return
  pushBounded(state.preseeks, {
    frame,
    sourceCount: bySource.size,
    timestampCount: [...bySource.values()].reduce((sum, timestamps) => sum + timestamps.length, 0),
    atMs: performance.now(),
  })
  scheduleDomSnapshot(state)
}

export function recordPreviewCanvasPool(sample: PreviewCanvasPoolSample): void {
  const state = getPerformanceState()
  if (!state) return
  if (
    sample.peakInUse <= maxCanvasPoolPeak &&
    sample.temporaryAllocations <= maxCanvasPoolTemporaryAllocations
  )
    return
  maxCanvasPoolPeak = Math.max(maxCanvasPoolPeak, sample.peakInUse)
  maxCanvasPoolTemporaryAllocations = Math.max(
    maxCanvasPoolTemporaryAllocations,
    sample.temporaryAllocations,
  )
  pushBounded(state.canvasPools, sample)
  scheduleDomSnapshot(state)
}

export function recordPreviewDecoderMetrics(sample: PreviewDecoderMetricsSample): void {
  const state = getPerformanceState()
  if (!state) return
  state.decoder = { ...sample }
  scheduleDomSnapshot(state)
}

// Publish the diagnostics object while application code still owns its global
// realm. Browser automation may run in a non-extensible isolated Window proxy.
getPerformanceState()

function copyPlaybackDiagnostics(serializedReport: string): void {
  const fallbackCopy = () => {
    const textarea = document.createElement('textarea')
    textarea.value = serializedReport
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }

  if (!navigator.clipboard) {
    fallbackCopy()
    return
  }
  void navigator.clipboard.writeText(serializedReport).catch(fallbackCopy)
}

// Diagnostic builds can reset/export the acceptance report directly from the
// real Tauri WebView. Cmd+Option+Shift+R / Cmd+Option+Shift+Y are deliberately
// obscure and exist only while the collector is compiled in.
if (SHOULD_PROFILE_PREVIEW_SCRUB && typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (!event.metaKey || !event.altKey || !event.shiftKey) return
    if (event.code === 'KeyR') {
      event.preventDefault()
      getPerformanceState()?.reset()
      return
    }
    if (event.code !== 'KeyY') return
    const report = getPreviewNativePlaybackForensicsReport()
    if (!report) return
    event.preventDefault()
    event.stopImmediatePropagation()
    copyPlaybackDiagnostics(JSON.stringify(report))
  })
}
