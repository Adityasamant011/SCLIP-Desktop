import type {
  FrameArtifact,
  InspectionObservationResult,
  PerceptionEvidence,
  VisualObservation,
} from './types.ts'

export interface DescribeComposedFrameOptions {
  frameArtifact?: FrameArtifact | null
  frame: number
  fps?: number
  projectRevision: string
  activeItems?: Array<{ id: string; label: string; type: string; text?: string; effects?: string[] }>
  captionFn?: (artifact: FrameArtifact) => Promise<{ text: string; sceneData?: unknown; ocr?: string[] } | null>
  timeoutMs?: number
}

/**
 * Generate a visual observation of a composited timeline frame with strict provenance tracking.
 */
export async function describeComposedFrame(
  options: DescribeComposedFrameOptions,
): Promise<InspectionObservationResult> {
  const fps = options.fps || 30
  const timeoutMs = options.timeoutMs ?? 4000
  const activeItems = options.activeItems ?? []
  const textOverlays = activeItems.filter((i) => i.type === 'text' && i.text).map((i) => i.text as string)
  const activeEffects = activeItems.flatMap((i) => i.effects ?? [])

  let semanticVisionPerformed = false
  let visualDescription = ''
  let sceneType: string | undefined
  let ocr: string[] | undefined

  if (options.frameArtifact && options.captionFn) {
    try {
      const captionPromise = options.captionFn(options.frameArtifact)
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
      const result = await Promise.race([captionPromise, timeoutPromise])

      if (result && result.text) {
        semanticVisionPerformed = true
        visualDescription = result.text
        ocr = result.ocr
        sceneType = typeof (result.sceneData as any)?.shotType === 'string'
          ? (result.sceneData as any).shotType
          : undefined
      }
    } catch {
      semanticVisionPerformed = false
    }
  }

  const structuralStateInspected = activeItems.length > 0
  const isVerified = semanticVisionPerformed

  const observation: VisualObservation = {
    description: visualDescription || (
      activeItems.length > 0
        ? `I could not visually inspect the pixels. Structural timeline telemetry at ${Number((options.frame / fps).toFixed(2))}s reports active items ${activeItems.map((i) => i.label || i.id).join(', ')}${textOverlays.length ? ` and text overlay "${textOverlays.join(' | ')}"` : ''}${activeEffects.length ? ` (configured effects: ${activeEffects.join(', ')})` : ''}.`
        : `I could not visually inspect the pixels. Structural timeline telemetry reports no active items at ${Number((options.frame / fps).toFixed(2))}s.`
    ),
    ocr,
    sceneType,
    activeElements: activeItems.map((i) => `${i.type}:${i.label || i.id}`),
    textOverlays: textOverlays.length ? textOverlays : undefined,
  }

  const evidence: PerceptionEvidence = {
    id: `composed:${options.projectRevision}:${options.frame}`,
    scope: 'composed',
    pixelsCaptured: !!options.frameArtifact,
    frameRendered: !!options.frameArtifact,
    // Capturing a frame is not the same as interpreting its pixels. Keep this
    // strict so Hermes never overstates what it has actually seen.
    pixelsAnalyzed: semanticVisionPerformed,
    semanticVisionPerformed,
    visualPixelsInspected: semanticVisionPerformed,
    structuralStateInspected,
    ocrPerformed: !!(ocr && ocr.length),
    audioAnalyzed: false,
    framesInspected: [options.frame],
    source: 'composed_preview',
    projectRevision: options.projectRevision,
    provider: semanticVisionPerformed ? 'local_vision_language_model' : 'structural_compositor_telemetry',
    model: semanticVisionPerformed ? 'configured-local-caption-model' : undefined,
    confidence: semanticVisionPerformed ? 0.92 : 0.85,
    analysisVersion: 'sclip-composed-perception-v1',
    degraded: !semanticVisionPerformed,
    degradedReason: semanticVisionPerformed
      ? undefined
      : options.frameArtifact
        ? 'VISION_MODEL_NO_RESULT'
        : 'COMPOSED_FRAME_CAPTURE_UNAVAILABLE',
  }

  return {
    status: isVerified ? 'verified' : 'degraded',
    observation,
    evidence,
    frameArtifact: options.frameArtifact ?? undefined,
  }
}
