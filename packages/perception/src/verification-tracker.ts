export type VisualVerificationStatus = 'verified' | 'stale' | 'unverified'

export interface VerificationState {
  currentRevision: string
  lastReviewedRevision: string | null
  status: VisualVerificationStatus
  lastReviewedFrame: number | null
  lastReviewedAt: string | null
  evidence: {
    semanticVisionPerformed: boolean
    visualPixelsInspected: boolean
    framesInspected: number[]
  }
}

export class VerificationTracker {
  private currentRevision: string
  private lastReviewedRevision: string | null = null
  private lastReviewedFrame: number | null = null
  private lastReviewedAt: string | null = null
  private semanticVisionPerformed = false
  private visualPixelsInspected = false
  private framesInspected: number[] = []

  constructor(initialRevision: string) {
    this.currentRevision = initialRevision
  }

  public updateCurrentRevision(newRevision: string): void {
    if (this.currentRevision !== newRevision) {
      this.currentRevision = newRevision
    }
  }

  public recordReview(params: {
    reviewedRevision: string
    frame: number
    semanticVisionPerformed: boolean
    visualPixelsInspected: boolean
    framesInspected?: number[]
  }): void {
    this.lastReviewedRevision = params.reviewedRevision
    this.lastReviewedFrame = params.frame
    this.lastReviewedAt = new Date().toISOString()
    this.semanticVisionPerformed = params.semanticVisionPerformed
    this.visualPixelsInspected = params.visualPixelsInspected
    this.framesInspected = params.framesInspected ?? [params.frame]
  }

  public getStatus(): VisualVerificationStatus {
    if (!this.lastReviewedRevision) return 'unverified'
    if (this.lastReviewedRevision !== this.currentRevision) return 'stale'
    return this.semanticVisionPerformed || this.visualPixelsInspected ? 'verified' : 'stale'
  }

  public getState(): VerificationState {
    return {
      currentRevision: this.currentRevision,
      lastReviewedRevision: this.lastReviewedRevision,
      status: this.getStatus(),
      lastReviewedFrame: this.lastReviewedFrame,
      lastReviewedAt: this.lastReviewedAt,
      evidence: {
        semanticVisionPerformed: this.semanticVisionPerformed,
        visualPixelsInspected: this.visualPixelsInspected,
        framesInspected: this.framesInspected,
      },
    }
  }
}
