import { describe, it, expect } from 'vitest'
import {
  probeCapabilities,
  probeMedia,
  VerificationTracker,
  describeComposedFrame,
  renderAuthoritativeTimelineFrame,
} from './index.ts'

describe('@sclip/perception Unit Tests', () => {
  describe('Capability Probing (Dynamic, non-static)', () => {
    it('probes runtime capability status and returns structured matrix', async () => {
      const caps = await probeCapabilities({
        hasWebGPU: false,
        hasNativeDecoder: true,
        hasLocalVisionWeights: false,
        hasAuthoritativeRenderer: true,
      })

      expect(caps.mediaDecode.status).toBe('available')
      expect(caps.timelineFrameRendering.status).toBe('available')
      expect(caps.visionUnderstanding.status).toBe('degraded')
      expect(caps.visionUnderstanding.reason).toBe('LOCAL_VISION_WEIGHTS_UNINITIALIZED')
      expect(caps.visionUnderstanding.fallbackAvailable).toBe(true)
      expect(caps.audioGeneration.status).toBe('unavailable')
      expect(caps.audioGeneration.reason).toBe('WEBGPU_BACKEND_UNAVAILABLE')
      expect(caps.mediaDecode.lastProbe).toBeDefined()
    })

    it('does not call the compositor available until a live capture surface is observed', async () => {
      const caps = await probeCapabilities({ hasNativeDecoder: true })
      expect(caps.timelineFrameRendering.status).toBe('degraded')
      expect(caps.timelineFrameRendering.reason).toBe('COMPOSITOR_CAPTURE_NOT_OBSERVED')
    })
  })

  describe('Source Media Probing & Proxy Recommendation', () => {
    it('recommends analysis proxy for ultra-wide 2940x1912 screen recordings', () => {
      const result = probeMedia({
        id: 'f45c82a2-cbd3-411e-b387-cf2a3f51ef0e',
        name: 'Screen Recording 2026-08-23 at 19.12.41.mov',
        mimeType: 'video/quicktime',
        duration: 9.35,
        width: 2940,
        height: 1912,
        fps: 30,
      })

      expect(result.durationFrames).toBe(281)
      expect(result.isProxyRecommended).toBe(true)
      expect(result.hasAudio).toBe(true)
    })

    it('does not require proxy for standard 1080p footage', () => {
      const result = probeMedia({
        id: 'standard-video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        duration: 5.0,
        width: 1920,
        height: 1080,
        fps: 30,
      })

      expect(result.isProxyRecommended).toBe(false)
    })
  })

  describe('Revision-Bound Visual Verification (Phase F)', () => {
    it('tracks revision lifecycle and invalidates verification on mutation', () => {
      const tracker = new VerificationTracker('sha256:revA')
      expect(tracker.getStatus()).toBe('unverified')

      // Record visual review on revA
      tracker.recordReview({
        reviewedRevision: 'sha256:revA',
        frame: 90,
        semanticVisionPerformed: true,
        visualPixelsInspected: true,
      })
      expect(tracker.getStatus()).toBe('verified')

      // Mutation occurs: state moves from revA -> revB
      tracker.updateCurrentRevision('sha256:revB')
      expect(tracker.getStatus()).toBe('stale')

      // Re-review on revB restores verification
      tracker.recordReview({
        reviewedRevision: 'sha256:revB',
        frame: 90,
        semanticVisionPerformed: true,
        visualPixelsInspected: true,
      })
      expect(tracker.getStatus()).toBe('verified')
    })
  })

  describe('Authoritative Composed Frame Rendering Delegation', () => {
    it('delegates to the authoritative compositor and constructs FrameArtifact', async () => {
      const mockRenderer = async (frame: number) => ({
        width: 1920,
        height: 1080,
        renderedItems: ['video-1', 'title-text'],
      })

      const result = await renderAuthoritativeTimelineFrame({
        frame: 45,
        projectRevision: 'sha256:testRev1234567890',
        fps: 30,
        renderer: mockRenderer,
      })

      expect(result.frame).toBe(45)
      expect(result.timeSeconds).toBe(1.5)
      expect(result.renderedItems).toEqual(['video-1', 'title-text'])
      expect(result.artifact?.width).toBe(1920)
      expect(result.artifact?.height).toBe(1080)
      expect(result.artifact?.sourceRevision).toBe('sha256:testRev1234567890')
      expect(result.artifact?.resourceRef).toMatch(/^sclip:\/\/frames\//)
    })
  })

  describe('Vision Provider & Evidence Provenance', () => {
    it('returns strict semanticVisionPerformed = true when vision model analyzes pixels', async () => {
      const observation = await describeComposedFrame({
        frame: 90,
        fps: 30,
        projectRevision: 'sha256:revA',
        frameArtifact: {
          id: 'frame-1',
          mimeType: 'image/jpeg',
          width: 1920,
          height: 1080,
        },
        activeItems: [
          { id: 'v1', label: 'Screen Recording', type: 'video' },
          { id: 't1', label: 'Title', type: 'text', text: 'Screen Recording' },
        ],
        captionFn: async () => ({
          text: 'VS Code editor window with React codebase and terminal open',
          ocr: ['src', 'timeline', 'App.tsx'],
        }),
      })

      expect(observation.status).toBe('verified')
      expect(observation.evidence.semanticVisionPerformed).toBe(true)
      expect(observation.evidence.visualPixelsInspected).toBe(true)
      expect(observation.evidence.ocrPerformed).toBe(true)
      expect(observation.observation.ocr).toEqual(['src', 'timeline', 'App.tsx'])
      expect(observation.observation.description).toContain('VS Code editor window')
    })

    it('falls back to structural telemetry without crashing when vision model is unavailable', async () => {
      const observation = await describeComposedFrame({
        frame: 90,
        fps: 30,
        projectRevision: 'sha256:revA',
        activeItems: [
          { id: 'v1', label: 'Screen Recording', type: 'video', effects: ['gpu-vhs', 'gpu-color-wheels'] },
          { id: 't1', label: 'Title', type: 'text', text: 'Screen Recording' },
        ],
      })

      expect(observation.status).toBe('degraded')
      expect(observation.evidence.semanticVisionPerformed).toBe(false)
      expect(observation.evidence.structuralStateInspected).toBe(true)
      expect(observation.observation.description).toContain('Screen Recording')
      expect(observation.observation.description).toContain('gpu-vhs')
      expect(observation.observation.textOverlays).toEqual(['Screen Recording'])
    })

    it('does not claim pixel analysis when a captured frame cannot be interpreted', async () => {
      const observation = await describeComposedFrame({
        frame: 90,
        fps: 30,
        projectRevision: 'sha256:revA',
        frameArtifact: { id: 'frame-2', mimeType: 'image/jpeg', width: 1920, height: 1080 },
        activeItems: [{ id: 'v1', label: 'Screen Recording', type: 'video' }],
        captionFn: async () => null,
      })

      expect(observation.status).toBe('degraded')
      expect(observation.evidence.frameRendered).toBe(true)
      expect(observation.evidence.pixelsAnalyzed).toBe(false)
      expect(observation.evidence.visualPixelsInspected).toBe(false)
    })
  })
})
