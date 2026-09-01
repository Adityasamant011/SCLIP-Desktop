import type { FrameArtifact } from './types.ts'

export type AuthoritativeFrameRenderer = (
  frame: number,
  options?: { quality?: number; width?: number; height?: number }
) => Promise<{
  canvas?: HTMLCanvasElement | OffscreenCanvas | null
  blob?: Blob | null
  width: number
  height: number
  renderedItems?: string[]
} | null>

export interface RenderTimelineFrameOptions {
  frame: number
  projectRevision: string
  fps?: number
  renderer: AuthoritativeFrameRenderer
}

/**
 * Renders a composited timeline frame by delegating strictly to the authoritative
 * SCLIP compositor/headless renderer (preserving single rendering truth).
 */
export async function renderAuthoritativeTimelineFrame(
  options: RenderTimelineFrameOptions,
): Promise<{
  artifact: FrameArtifact | null
  renderedItems: string[]
  frame: number
  timeSeconds: number
}> {
  const fps = options.fps || 30
  const timeSeconds = Number((options.frame / fps).toFixed(3))

  const rendered = await options.renderer(options.frame, { quality: 0.88 })
  if (!rendered) {
    return {
      artifact: null,
      renderedItems: [],
      frame: options.frame,
      timeSeconds,
    }
  }

  const frameId = `frame_${options.projectRevision.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}_${options.frame}`
  const artifact: FrameArtifact = {
    id: frameId,
    mimeType: 'image/jpeg',
    width: rendered.width,
    height: rendered.height,
    resourceRef: `sclip://frames/${frameId}`,
    sourceRevision: options.projectRevision,
    sourceFrame: options.frame,
    sourceTime: timeSeconds,
  }

  return {
    artifact,
    renderedItems: rendered.renderedItems || [],
    frame: options.frame,
    timeSeconds,
  }
}
