import { createLogger } from '@/shared/logging/logger'
import { createLfmSceneWorker } from '../create-lfm-worker'
import { seekVideo } from '../scene-detection-utils'
import type { CaptioningOptions, MediaCaption, MediaCaptioningProvider } from './types'

const log = createLogger('LfmCaptioningProvider')

const MAX_DIM = 512
const DEFAULT_SAMPLE_INTERVAL_SEC = 3
const INIT_TIMEOUT_MS = 180_000
const CAPTION_TIMEOUT_MS = 90_000

// Keep the local VLM warm for the lifetime of the editor page. Model weights
// remain in the browser cache across launches, while this worker preserves the
// much more expensive in-memory WebGPU initialization between inspections.
let sharedWorker: Worker | null = null
let sharedWorkerReady: Promise<Worker> | null = null
let nextCaptionRequestId = 0
let captionQueue: Promise<void> = Promise.resolve()

async function captureFrame(video: HTMLVideoElement, timeSec: number): Promise<Blob> {
  await seekVideo(video, timeSec)

  const vw = video.videoWidth || 640
  const vh = video.videoHeight || 360
  const scale = Math.min(MAX_DIM / Math.max(vw, vh), 1)
  const width = Math.round(vw * scale)
  const height = Math.round(vh * scale)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not acquire captioning canvas context')
  }

  context.drawImage(video, 0, 0, width, height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}

function waitForReady(
  worker: Worker,
  onProgress?: CaptioningOptions['onProgress'],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timeout = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error('LFM worker init timed out'))
    }, INIT_TIMEOUT_MS)

    const resetWatchdog = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        worker.removeEventListener('message', onMessage)
        reject(new Error('LFM worker init timed out'))
      }, INIT_TIMEOUT_MS)
    }

    const cleanup = () => {
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
    }

    const onMessage = (event: MessageEvent) => {
      const message = event.data
      if (message.type === 'ready') {
        cleanup()
        resolve()
        return
      }

      if (message.type === 'error') {
        cleanup()
        reject(new Error(message.message))
        return
      }

      if (message.type === 'progress') {
        resetWatchdog()
        onProgress?.({
          stage: message.stage || 'loading-model',
          percent: message.percent ?? 0,
          framesAnalyzed: 0,
          totalFrames: 0,
        })
      }

      if (message.type === 'debug') {
        resetWatchdog()
      }
    }

    worker.addEventListener('message', onMessage)
    worker.postMessage({ type: 'init' })
  })
}

function discardSharedWorker(worker: Worker): void {
  if (sharedWorker !== worker) return
  sharedWorker = null
  sharedWorkerReady = null
  try {
    worker.postMessage({ type: 'dispose' })
  } catch {
    // A failed worker may no longer accept messages. Terminating it is enough.
  }
  worker.terminate()
}

function getReadyWorker(onProgress?: CaptioningOptions['onProgress']): Promise<Worker> {
  if (sharedWorkerReady) return sharedWorkerReady

  const worker = createLfmSceneWorker()
  sharedWorker = worker
  sharedWorkerReady = waitForReady(worker, onProgress)
    .then(() => worker)
    .catch((error) => {
      discardSharedWorker(worker)
      throw error
    })
  return sharedWorkerReady
}

function enqueueCaption<T>(task: () => Promise<T>): Promise<T> {
  const result = captionQueue.then(task, task)
  captionQueue = result.then(() => undefined, () => undefined)
  return result
}

function captionSingle(
  worker: Worker,
  id: number,
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<Pick<MediaCaption, 'text' | 'sceneData'>> {
  return new Promise<Pick<MediaCaption, 'text' | 'sceneData'>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      discardSharedWorker(worker)
      reject(new Error('LFM caption request timed out'))
    }, CAPTION_TIMEOUT_MS)
    const onAbort = () => {
      cleanup()
      reject(signal!.reason)
    }

    const cleanup = () => {
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data.type === 'caption' && event.data.id === id) {
        cleanup()
        resolve({
          text: event.data.caption ?? '',
          sceneData: event.data.sceneData,
        })
      }
      if (event.data.type === 'error') {
        cleanup()
        discardSharedWorker(worker)
        reject(new Error(event.data.message || 'LFM caption request failed'))
      }
    }

    const onError = (event: ErrorEvent) => {
      cleanup()
      discardSharedWorker(worker)
      reject(new Error(event.message || 'Caption worker error'))
    }

    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ type: 'describe', id, image: imageBlob })
  })
}

export const lfmCaptioningProvider: MediaCaptioningProvider = {
  id: 'lfm-captioning',
  label: 'LFM 2.5 VL',
  async captionVideo(video, options = {}) {
    const {
      onProgress,
      signal,
      sampleIntervalSec: rawSampleInterval = DEFAULT_SAMPLE_INTERVAL_SEC,
      saveThumbnail,
    } = options
    const sampleIntervalSec =
      Number.isFinite(rawSampleInterval) && rawSampleInterval > 0
        ? rawSampleInterval
        : DEFAULT_SAMPLE_INTERVAL_SEC

    const worker = await getReadyWorker(onProgress)
    if (signal?.aborted) {
      return []
    }

    const duration = video.duration || 0
    if (duration <= 0) {
      return []
    }

    const timestamps: number[] = []
    for (let time = 0; time < duration; time += sampleIntervalSec) {
      timestamps.push(time)
    }

    if (
      timestamps.length > 0 &&
      timestamps[timestamps.length - 1]! + sampleIntervalSec * 0.5 < duration
    ) {
      timestamps.push(Math.max(0, duration - 0.1))
    }

    const captions: MediaCaption[] = []

    for (let index = 0; index < timestamps.length; index += 1) {
      if (signal?.aborted) {
        break
      }

      const timeSec = timestamps[index]!
      const blob = await captureFrame(video, timeSec)

      onProgress?.({
        stage: 'captioning',
        percent: ((index + 1) / timestamps.length) * 100,
        framesAnalyzed: index,
        totalFrames: timestamps.length,
      })

      const result = await enqueueCaption(() =>
        captionSingle(worker, nextCaptionRequestId++, blob, signal),
      )
      if (result.text) {
        let thumbRelPath: string | undefined
        if (saveThumbnail) {
          try {
            thumbRelPath = await saveThumbnail(index, blob)
          } catch (error) {
            log.warn('Caption thumbnail persist failed — skipping', { index, error })
          }
        }
        captions.push({
          timeSec: Math.round(timeSec * 10) / 10,
          text: result.text,
          ...(result.sceneData ? { sceneData: result.sceneData } : {}),
          ...(thumbRelPath ? { thumbRelPath } : {}),
        })
      }

      log.info('Frame caption', {
        frame: index,
        time: timeSec.toFixed(1),
        length: result.text.length,
      })
    }

    return captions
  },
  async captionImage(imageBlob, options = {}) {
    const { onProgress, signal, saveThumbnail } = options

    const worker = await getReadyWorker(onProgress)
    if (signal?.aborted) {
      return []
    }

    onProgress?.({
      stage: 'captioning',
      percent: 30,
      framesAnalyzed: 0,
      totalFrames: 1,
    })

    let processBlob = imageBlob
    try {
      const bitmap = await createImageBitmap(imageBlob)
      const scale = Math.min(MAX_DIM / Math.max(bitmap.width, bitmap.height), 1)
      const width = Math.round(bitmap.width * scale)
      const height = Math.round(bitmap.height * scale)
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(bitmap, 0, 0, width, height)
        processBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
      }
      bitmap.close()
    } catch {
      // Fallback to raw blob if createImageBitmap is not supported
    }

    const result = await enqueueCaption(() =>
      captionSingle(worker, nextCaptionRequestId++, processBlob, signal),
    )

    let thumbRelPath: string | undefined
    if (result.text && saveThumbnail) {
      try {
        thumbRelPath = await saveThumbnail(0, processBlob)
      } catch (error) {
        log.warn('Image caption thumbnail persist failed — skipping', { error })
      }
    }

    onProgress?.({
      stage: 'captioning',
      percent: 100,
      framesAnalyzed: 1,
      totalFrames: 1,
    })

    log.info('Image caption', { length: result.text.length })
    return result.text
      ? [
          {
            timeSec: 0,
            text: result.text,
            ...(result.sceneData ? { sceneData: result.sceneData } : {}),
            ...(thumbRelPath ? { thumbRelPath } : {}),
          },
        ]
      : []
  },
}
