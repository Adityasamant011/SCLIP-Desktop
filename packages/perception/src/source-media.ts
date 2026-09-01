import type { FrameArtifact, SceneCut } from './types.ts'

export interface ProbeMediaResult {
  assetId: string
  fileName: string
  mimeType: string
  durationSeconds: number
  durationFrames: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  isProxyRecommended: boolean
}

export interface ExtractSourceFrameOptions {
  assetId: string
  sourcePath?: string
  sourceUrl?: string
  timestampSeconds: number
  fps?: number
  maxWidth?: number
  maxHeight?: number
}

/**
 * Probe media asset metadata and determine if a 720p analysis proxy is recommended.
 */
export function probeMedia(asset: {
  id: string
  name: string
  mimeType: string
  duration?: number
  width?: number
  height?: number
  fps?: number
}): ProbeMediaResult {
  const width = asset.width || 1920
  const height = asset.height || 1080
  const fps = asset.fps || 30
  const durationSeconds = asset.duration || 0
  const durationFrames = Math.round(durationSeconds * fps)

  // Recommend 720p analysis proxy if resolution exceeds 1080p (e.g. 2940x1912 ultra-wide)
  const isProxyRecommended = width > 1920 || height > 1080

  return {
    assetId: asset.id,
    fileName: asset.name,
    mimeType: asset.mimeType,
    durationSeconds,
    durationFrames,
    width,
    height,
    fps,
    hasAudio: asset.mimeType.startsWith('audio/') || asset.mimeType.startsWith('video/'),
    isProxyRecommended,
  }
}

/**
 * Detect scene cut boundaries using deterministic frame difference / histogram metrics.
 */
export function detectSceneCutsFromSamples(
  samples: Array<{ frame: number; timestampSeconds: number; differenceScore: number }>,
  threshold = 0.35,
): SceneCut[] {
  const cuts: SceneCut[] = []
  for (const sample of samples) {
    if (sample.differenceScore >= threshold) {
      cuts.push({
        frame: sample.frame,
        timestampSeconds: sample.timestampSeconds,
        confidence: Math.min(1, sample.differenceScore / (threshold * 2)),
        method: 'histogram',
      })
    }
  }
  return cuts
}
