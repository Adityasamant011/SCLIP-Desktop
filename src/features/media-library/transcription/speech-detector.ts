import { createLogger } from '@/shared/logging/logger'
import type { SpeechDetection } from './speech-detection'

const logger = createLogger('SpeechDetector')

type DetectorMessage =
  | { type: 'done'; detection: SpeechDetection }
  | { type: 'error'; message: string }

export interface DetectSpeechOptions {
  timeoutMs?: number
}

/**
 * A one-job worker on purpose: it is a 2.2 MB CPU VAD that is loaded only
 * while transcription is requested, and released immediately afterwards.
 */
export function detectSpeechInFile(file: File, options?: DetectSpeechOptions): Promise<SpeechDetection> {
  const timeoutMs = options?.timeoutMs ?? 60_000
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/speech-detector.worker.ts', import.meta.url), { type: 'module' })
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      worker.terminate()
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Speech detection timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    worker.onmessage = (event: MessageEvent<DetectorMessage>) => {
      cleanup()
      if (event.data.type === 'done') {
        const detection = event.data.detection
        if (detection.metrics) {
          logger.info('VAD detection complete', {
            speechDetected: detection.speechDetected,
            speechConfidence: detection.speechConfidence,
            rangesCount: detection.speechRanges.length,
            ...detection.metrics,
          })
        }
        resolve(detection)
      } else {
        reject(new Error(event.data.message))
      }
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Speech detector worker failed'))
    }
    worker.postMessage({ type: 'analyze', file })
  })
}
