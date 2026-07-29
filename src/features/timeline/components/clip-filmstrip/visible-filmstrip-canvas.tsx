import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import type { FilmstripFrame } from '../../hooks/use-filmstrip'
import { useTimelineViewportStore } from '../../stores/timeline-viewport-store'
import { useZoomStore } from '../../stores/zoom-store'
import {
  computeCoverDrawRect,
  computeFilmstripCanvasGeometry,
  computeFilmstripCanvasTiles,
  type FilmstripCanvasGeometry,
  type FilmstripCanvasTile,
} from './filmstrip-canvas-geometry'
import { getDecodedFilmstripImage, subscribeFilmstripImage } from './filmstrip-image-cache'

const MAX_FILMSTRIP_CANVAS_DPR = 2

type DrawableFilmstripSource = ImageBitmap | HTMLImageElement

interface VisibleFilmstripCanvasProps {
  renderWidth: number
  height: number
  visibleStartPx: number
  visibleEndPx: number
  frames: FilmstripFrame[]
  pixelsPerSecond: number
  effectiveStart: number
  effectiveEnd: number
  speed: number
  isReversed: boolean
  tileWidth: number
  coverFrame: FilmstripFrame | null
  onSourceError?: (frameIndex: number) => void
  liveTimelineViewport?: boolean
  liveViewportOverscanPx?: number
}

interface LiveFilmstripCanvasWindow {
  renderWidth: number
  visibleStartPx: number
  visibleEndPx: number
}

interface LiveFilmstripCanvasRegistration {
  canvas: HTMLCanvasElement
  host: HTMLElement | null
  timelineViewport: HTMLElement | null
  overscanPx: number
  paint: (pixelsPerSecond: number, window: LiveFilmstripCanvasWindow) => void
}

const liveFilmstripCanvasRegistrations = new Set<LiveFilmstripCanvasRegistration>()
let liveFilmstripCanvasUpdateQueued = false
let unsubscribeLiveFilmstripZoom: (() => void) | null = null
let unsubscribeLiveFilmstripViewport: (() => void) | null = null

function measureLiveFilmstripCanvasWindow(
  registration: Pick<LiveFilmstripCanvasRegistration, 'host' | 'timelineViewport' | 'overscanPx'>,
  viewportRectCache?: Map<HTMLElement, DOMRect>,
): LiveFilmstripCanvasWindow | null {
  const { host, timelineViewport } = registration
  if (!host || !timelineViewport) return null

  const hostRect = host.getBoundingClientRect()
  const hostWidth = Math.max(0, hostRect.width)
  if (hostWidth <= 0) return null

  let viewportRect = viewportRectCache?.get(timelineViewport)
  if (!viewportRect) {
    viewportRect = timelineViewport.getBoundingClientRect()
    viewportRectCache?.set(timelineViewport, viewportRect)
  }

  const overscanPx = Math.max(0, registration.overscanPx)
  const left = Math.max(0, Math.min(hostWidth, viewportRect.left - overscanPx - hostRect.left))
  const right = Math.max(
    left,
    Math.min(hostWidth, viewportRect.left + viewportRect.width + overscanPx - hostRect.left),
  )
  return {
    renderWidth: hostWidth,
    visibleStartPx: Math.floor(left),
    visibleEndPx: Math.ceil(right),
  }
}

function scheduleLiveFilmstripCanvasUpdate(): void {
  if (liveFilmstripCanvasUpdateQueued) return
  liveFilmstripCanvasUpdateQueued = true
  queueMicrotask(() => {
    liveFilmstripCanvasUpdateQueued = false
    const pixelsPerSecond = useZoomStore.getState().pixelsPerSecond
    const viewportRectCache = new Map<HTMLElement, DOMRect>()
    const updates: Array<{
      registration: LiveFilmstripCanvasRegistration
      canvasWindow: LiveFilmstripCanvasWindow
    }> = []

    // Read every live rectangle before painting any canvas. The upstream zoom
    // handler has already paired the real-width geometry and anchored scroll in
    // one RAF, so this microtask sees the final state without forcing a
    // read/write layout cycle for each visible filmstrip.
    for (const registration of liveFilmstripCanvasRegistrations) {
      if (!registration.canvas.isConnected) continue
      const canvasWindow = measureLiveFilmstripCanvasWindow(registration, viewportRectCache)
      if (canvasWindow) {
        updates.push({ registration, canvasWindow })
      }
    }
    for (const update of updates) {
      update.registration.paint(pixelsPerSecond, update.canvasWindow)
    }
  })
}

function registerLiveFilmstripCanvas(
  canvas: HTMLCanvasElement,
  overscanPx: number,
  paint: LiveFilmstripCanvasRegistration['paint'],
): () => void {
  const host = canvas.parentElement
  const timelineViewport = canvas.closest<HTMLElement>('[data-timeline-scroll-container]')
  if (!host || !timelineViewport) {
    return () => {}
  }
  const registration: LiveFilmstripCanvasRegistration = {
    canvas,
    host,
    timelineViewport,
    overscanPx,
    paint,
  }
  liveFilmstripCanvasRegistrations.add(registration)

  if (!unsubscribeLiveFilmstripZoom) {
    unsubscribeLiveFilmstripZoom = useZoomStore.subscribe((state, previousState) => {
      if (state.pixelsPerSecond !== previousState.pixelsPerSecond) {
        scheduleLiveFilmstripCanvasUpdate()
      }
    })
  }
  if (!unsubscribeLiveFilmstripViewport) {
    unsubscribeLiveFilmstripViewport = useTimelineViewportStore.subscribe(
      (state, previousState) => {
        if (
          state.scrollLeft !== previousState.scrollLeft ||
          state.viewportWidth !== previousState.viewportWidth
        ) {
          scheduleLiveFilmstripCanvasUpdate()
        }
      },
    )
  }

  return () => {
    liveFilmstripCanvasRegistrations.delete(registration)
    if (liveFilmstripCanvasRegistrations.size === 0 && unsubscribeLiveFilmstripZoom) {
      unsubscribeLiveFilmstripZoom()
      unsubscribeLiveFilmstripZoom = null
    }
    if (liveFilmstripCanvasRegistrations.size === 0 && unsubscribeLiveFilmstripViewport) {
      unsubscribeLiveFilmstripViewport()
      unsubscribeLiveFilmstripViewport = null
    }
  }
}

function isDrawableBitmap(bitmap: ImageBitmap | undefined): bitmap is ImageBitmap {
  return !!bitmap && bitmap.width > 0 && bitmap.height > 0
}

let nextBitmapIdentity = 1
const bitmapIdentities = new WeakMap<object, number>()

function getBitmapIdentity(bitmap: ImageBitmap | undefined): number {
  if (!isDrawableBitmap(bitmap)) return 0
  const existing = bitmapIdentities.get(bitmap)
  if (existing !== undefined) return existing
  const identity = nextBitmapIdentity++
  bitmapIdentities.set(bitmap, identity)
  return identity
}

function getFrameSignature(frame: FilmstripFrame | null): string {
  if (!frame) return '-'
  return `${frame.index}:${frame.url}:${getBitmapIdentity(frame.bitmap)}`
}

function getTileSignature(tile: FilmstripCanvasTile): string {
  return `${tile.slot}:${tile.x}:${tile.width}:${getFrameSignature(tile.frame)}`
}

export const VisibleFilmstripCanvas = memo(function VisibleFilmstripCanvas({
  renderWidth,
  height,
  visibleStartPx,
  visibleEndPx,
  frames,
  pixelsPerSecond,
  effectiveStart,
  effectiveEnd,
  speed,
  isReversed,
  tileWidth,
  coverFrame,
  onSourceError,
  liveTimelineViewport = false,
  liveViewportOverscanPx = 0,
}: VisibleFilmstripCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const subscriptionsRef = useRef<Map<string, { frameIndex: number; unsubscribe: () => void }>>(
    new Map(),
  )
  const redrawRafRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const imageRevisionRef = useRef(0)
  const onSourceErrorRef = useRef(onSourceError)
  const redrawRef = useRef<() => void>(() => {})
  const paintLiveRef = useRef<
    (livePixelsPerSecond: number, window: LiveFilmstripCanvasWindow) => void
  >(() => {})
  const lastDrawSignatureRef = useRef<string | null>(null)

  const scheduleRedraw = useCallback(() => {
    if (!mountedRef.current || redrawRafRef.current !== null) return
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = null
      if (mountedRef.current) {
        redrawRef.current()
      }
    })
  }, [])

  const syncSourceSubscriptions = useCallback(
    (sourceFrames: FilmstripFrame[]) => {
      const neededByUrl = new Map<string, FilmstripFrame>()
      for (const frame of sourceFrames) {
        if (frame.url && !isDrawableBitmap(frame.bitmap)) {
          neededByUrl.set(frame.url, frame)
        }
      }

      for (const [url, frame] of neededByUrl) {
        const existing = subscriptionsRef.current.get(url)
        if (existing?.frameIndex === frame.index) continue
        existing?.unsubscribe()

        const notifyChange = () => {
          imageRevisionRef.current += 1
          scheduleRedraw()
        }
        const notifyError = () => {
          imageRevisionRef.current += 1
          onSourceErrorRef.current?.(frame.index)
          scheduleRedraw()
        }
        const unsubscribe = subscribeFilmstripImage(url, notifyChange, notifyError)
        subscriptionsRef.current.set(url, { frameIndex: frame.index, unsubscribe })
      }

      for (const [url, subscription] of subscriptionsRef.current) {
        if (neededByUrl.has(url)) continue
        subscription.unsubscribe()
        subscriptionsRef.current.delete(url)
      }
    },
    [scheduleRedraw],
  )

  useEffect(() => {
    mountedRef.current = true
    const subscriptions = subscriptionsRef.current
    return () => {
      mountedRef.current = false
      if (redrawRafRef.current !== null) {
        cancelAnimationFrame(redrawRafRef.current)
        redrawRafRef.current = null
      }
      for (const subscription of subscriptions.values()) {
        subscription.unsubscribe()
      }
      subscriptions.clear()
    }
  }, [])

  useEffect(() => {
    if (!liveTimelineViewport) return
    const canvas = canvasRef.current
    if (!canvas) return
    return registerLiveFilmstripCanvas(canvas, liveViewportOverscanPx, (livePps, canvasWindow) => {
      paintLiveRef.current(livePps, canvasWindow)
    })
  }, [liveTimelineViewport, liveViewportOverscanPx])

  const drawWindow = useCallback(
    (drawPixelsPerSecond: number, canvasWindow: LiveFilmstripCanvasWindow) => {
      const canvas = canvasRef.current
      if (!canvas || height <= 0) return

      const geometry: FilmstripCanvasGeometry = computeFilmstripCanvasGeometry(
        canvasWindow.renderWidth,
        canvasWindow.visibleStartPx,
        canvasWindow.visibleEndPx,
      )
      const tiles = computeFilmstripCanvasTiles({
        frames,
        renderWidth: canvasWindow.renderWidth,
        visibleStartPx: canvasWindow.visibleStartPx,
        visibleEndPx: canvasWindow.visibleEndPx,
        tileWidth,
        pixelsPerSecond: drawPixelsPerSecond,
        effectiveStart,
        effectiveEnd,
        speed,
        isReversed,
      })
      syncSourceSubscriptions([
        ...(coverFrame ? [coverFrame] : []),
        ...tiles.map((tile) => tile.frame),
      ])

      if (geometry.width <= 0) {
        canvas.style.display = 'none'
        lastDrawSignatureRef.current = null
        return
      }

      const dpr = Math.max(1, Math.min(MAX_FILMSTRIP_CANVAS_DPR, window.devicePixelRatio || 1))
      const backingWidth = Math.max(1, Math.ceil(geometry.width * dpr))
      const backingHeight = Math.max(1, Math.ceil(height * dpr))
      const drawSignature = [
        geometry.left,
        geometry.width,
        height,
        dpr,
        backingWidth,
        backingHeight,
        imageRevisionRef.current,
        getFrameSignature(coverFrame),
        ...tiles.map(getTileSignature),
      ].join('|')
      if (canvas.style.display !== 'none' && lastDrawSignatureRef.current === drawSignature) {
        return
      }

      canvas.style.display = 'block'
      canvas.style.left = `${geometry.left}px`
      canvas.style.width = `${geometry.width}px`
      canvas.style.height = `${height}px`
      if (canvas.width !== backingWidth) {
        canvas.width = backingWidth
      }
      if (canvas.height !== backingHeight) {
        canvas.height = backingHeight
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, geometry.width, height)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'low'

      const resolveSource = (frame: FilmstripFrame | null): DrawableFilmstripSource | null => {
        if (!frame) return null
        if (isDrawableBitmap(frame.bitmap)) return frame.bitmap
        if (!frame.url) return null
        return getDecodedFilmstripImage(frame.url)
      }
      const coverSource = resolveSource(coverFrame)

      for (const tile of tiles) {
        const localX = tile.x - geometry.left
        if (localX >= geometry.width || localX + tile.width <= 0) continue

        const source = resolveSource(tile.frame) ?? coverSource
        if (!source) continue

        const drawRect = computeCoverDrawRect(source.width, source.height, tile.width, height)
        if (drawRect.width <= 0 || drawRect.height <= 0) continue

        ctx.save()
        ctx.beginPath()
        ctx.rect(localX, 0, tile.width, height)
        ctx.clip()
        try {
          ctx.drawImage(source, localX + drawRect.x, drawRect.y, drawRect.width, drawRect.height)
        } catch {
          // A transferred ImageBitmap can be replaced and closed between render
          // and paint. The next cache update supplies its persisted URL frame.
        }
        ctx.restore()
      }
      lastDrawSignatureRef.current = drawSignature
    },
    [
      coverFrame,
      effectiveEnd,
      effectiveStart,
      frames,
      height,
      isReversed,
      speed,
      syncSourceSubscriptions,
      tileWidth,
    ],
  )

  const redrawCurrent = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let drawPixelsPerSecond = pixelsPerSecond
    let currentWindow: LiveFilmstripCanvasWindow = {
      renderWidth,
      visibleStartPx,
      visibleEndPx,
    }
    if (liveTimelineViewport) {
      const measuredWindow = measureLiveFilmstripCanvasWindow({
        host: canvas.parentElement,
        timelineViewport: canvas.closest<HTMLElement>('[data-timeline-scroll-container]'),
        overscanPx: liveViewportOverscanPx,
      })
      if (measuredWindow) {
        currentWindow = measuredWindow
        drawPixelsPerSecond = useZoomStore.getState().pixelsPerSecond
      }
    }
    drawWindow(drawPixelsPerSecond, currentWindow)
  }, [
    drawWindow,
    liveTimelineViewport,
    liveViewportOverscanPx,
    pixelsPerSecond,
    renderWidth,
    visibleEndPx,
    visibleStartPx,
  ])

  useLayoutEffect(() => {
    // Store-driven callbacks must use the last committed tile metadata. Refs are
    // shared with work-in-progress fibers, so publish only after React commits.
    onSourceErrorRef.current = onSourceError
    paintLiveRef.current = drawWindow
    redrawRef.current = redrawCurrent
    redrawCurrent()
  }, [drawWindow, onSourceError, redrawCurrent])

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 pointer-events-none"
      data-filmstrip-canvas
      aria-hidden="true"
    />
  )
})
