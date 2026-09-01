export interface FrameArtifact {
  id: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  localPath?: string
  resourceRef?: string
  sourceRevision?: string
  sourceFrame?: number
  sourceTime?: number
}

export interface PerceptionEvidence {
  /** Stable identity for this observation; never reuse a composed id across revisions. */
  id: string
  scope: 'source' | 'composed'
  /** Whether an actual image/frame artifact was captured for this observation. */
  pixelsCaptured: boolean
  frameRendered: boolean
  pixelsAnalyzed: boolean
  /** True only when a vision provider actually interpreted frame pixels. */
  visualPixelsInspected: boolean
  semanticVisionPerformed: boolean
  structuralStateInspected: boolean
  ocrPerformed: boolean
  audioAnalyzed: boolean
  framesInspected: number[]
  /** Actual component that supplied the observation, never a guessed capability. */
  source: 'source_media_analysis' | 'composed_preview'
  projectRevision?: string
  sourceAssetFingerprint?: string
  analysisVersion: string
  provider: string
  model?: string
  confidence: number
  degraded: boolean
  degradedReason?: string
}

export interface VisualObservation {
  description: string
  ocr?: string[]
  sceneType?: string
  dominantColors?: string[]
  brightness?: number
  activeElements?: string[]
  textOverlays?: string[]
}

export interface InspectionObservationResult {
  status: 'verified' | 'degraded' | 'unavailable'
  observation: VisualObservation
  evidence: PerceptionEvidence
  frameArtifact?: FrameArtifact
}

export interface CapabilityDetail {
  status: 'available' | 'degraded' | 'unavailable'
  backend?: string
  reason?: string
  fallbackAvailable?: boolean
  fallback?: string
  lastProbe?: string
}

export interface CapabilityMatrix {
  mediaDecode: CapabilityDetail
  sourceFrameExtraction: CapabilityDetail
  timelineFrameRendering: CapabilityDetail
  visionUnderstanding: CapabilityDetail
  sceneDetection: CapabilityDetail
  transcription: CapabilityDetail
  audioGeneration: CapabilityDetail
  render: CapabilityDetail
}

export interface SceneCut {
  timestampSeconds: number
  frame: number
  confidence: number
  method: 'histogram' | 'adaptive' | 'native'
}
