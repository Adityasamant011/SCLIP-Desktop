import { describe, it, expect } from 'vitest'
import {
  buildProjectSummary,
  buildTimelineWindow,
  type ProjectSummary,
  type TimelineWindowResult,
} from './index.ts'

describe('Project Intelligence & Bounded Retrieval (Phase 1)', () => {
  const mockTracks = [
    { id: 'track-v1', kind: 'video' },
    { id: 'track-v2', kind: 'video' },
    { id: 'track-a1', kind: 'audio' },
    { id: 'track-t1', kind: 'text' },
  ]

  // Synthetic 45-minute project (2700 seconds = 81,000 frames @ 30fps)
  // Contains 180 video clips, 180 audio clips, 50 text overlays, ~4,000 words
  function create45MinLongFormFixture() {
    const fps = 30
    const totalDurationSec = 2700 // 45 min
    const clipDurationSec = 15 // each clip is 15s
    const clipCount = totalDurationSec / clipDurationSec // 180 clips

    const items: Array<{
      id: string
      type: string
      trackId: string
      from: number
      durationInFrames: number
      label: string
      mediaId?: string
      text?: string
      sourceStart?: number
      sourceDuration?: number
      transform?: Record<string, unknown>
      effects?: Array<{ id: string }>
    }> = []

    const transcriptTokens: Array<{
      wordId: string
      itemId: string
      mediaId: string
      text: string
      confidence: number
      speaker: string
      startFrame: number
      endFrame: number
      sourceStart: number
      sourceEnd: number
    }> = []

    const transcriptSegmentsByMediaId: Record<string, Array<{ text: string; startSec: number; endSec: number; words?: any[] }>> = {}
    const visualMomentsByMediaId: Record<string, Array<{ timeSec: number; text: string; scene?: any }>> = {}

    for (let i = 0; i < clipCount; i++) {
      const mediaId = `media-asset-${i % 20}` // 20 unique media assets
      const fromFrame = i * clipDurationSec * fps
      const durationFrames = clipDurationSec * fps

      // Video item on V1
      const videoItemId = `video-item-${i}`
      items.push({
        id: videoItemId,
        type: 'video',
        trackId: 'track-v1',
        from: fromFrame,
        durationInFrames: durationFrames,
        label: `Scene Take ${i}`,
        mediaId,
        sourceStart: 0,
        sourceDuration: durationFrames,
        transform: { scaleX: 1, scaleY: 1, x: 0, y: 0, opacity: 1 },
      })

      // Audio item on A1
      const audioItemId = `audio-item-${i}`
      items.push({
        id: audioItemId,
        type: 'audio',
        trackId: 'track-a1',
        from: fromFrame,
        durationInFrames: durationFrames,
        label: `Audio Dialogue ${i}`,
        mediaId,
        sourceStart: 0,
        sourceDuration: durationFrames,
      })

      // Overlay text item every 5th clip
      if (i % 5 === 0) {
        items.push({
          id: `text-item-${i}`,
          type: 'text',
          trackId: 'track-t1',
          from: fromFrame + 30,
          durationInFrames: 90,
          label: `Title ${i}`,
          text: `Chapter ${Math.floor(i / 5) + 1}`,
        })
      }

      // Generate 20 transcript words per clip
      const clipWords: any[] = []
      for (let w = 0; w < 20; w++) {
        const wordStartFrame = fromFrame + w * 22
        const wordEndFrame = wordStartFrame + 18
        const wordToken = {
          wordId: `word-${i}-${w}`,
          itemId: audioItemId,
          mediaId,
          text: `token_${i}_${w}`,
          confidence: 0.95,
          speaker: i % 2 === 0 ? 'Host' : 'Guest',
          startFrame: wordStartFrame,
          endFrame: wordEndFrame,
          sourceStart: w * 0.75,
          sourceEnd: (w + 1) * 0.75,
        }
        transcriptTokens.push(wordToken)
        clipWords.push({
          id: wordToken.wordId,
          text: wordToken.text,
          startSec: Number((wordStartFrame / fps).toFixed(3)),
          endSec: Number((wordEndFrame / fps).toFixed(3)),
          confidence: 0.95,
          speaker: wordToken.speaker,
        })
      }

      if (!transcriptSegmentsByMediaId[mediaId]) {
        transcriptSegmentsByMediaId[mediaId] = []
      }
      transcriptSegmentsByMediaId[mediaId].push({
        text: `Segment dialogue for clip ${i}`,
        startSec: Number((fromFrame / fps).toFixed(3)),
        endSec: Number(((fromFrame + durationFrames) / fps).toFixed(3)),
        words: clipWords,
      })

      if (!visualMomentsByMediaId[mediaId]) {
        visualMomentsByMediaId[mediaId] = [
          { timeSec: 2.5, text: 'Speaker at desk speaking into mic', scene: { shotType: 'medium', subjects: ['person'] } },
          { timeSec: 7.5, text: 'Close-up of laptop screen with code', scene: { shotType: 'close_up', subjects: ['screen'] } },
        ]
      }
    }

    return {
      projectId: 'longform-project-45m',
      projectName: 'Full 45-Minute Podcast Master',
      projectRevision: 'rev-45m-longform-hash',
      fps,
      width: 1920,
      height: 1080,
      tracks: mockTracks,
      items,
      transcriptTokens,
      transcriptSegmentsByMediaId,
      visualMomentsByMediaId,
    }
  }

  describe('Step 4 — video_get_project_summary', () => {
    it('produces a bounded summary for a 45-minute project without item arrays', () => {
      const fixture = create45MinLongFormFixture()
      const summary = buildProjectSummary({
        projectId: fixture.projectId,
        projectName: fixture.projectName,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        width: fixture.width,
        height: fixture.height,
        tracks: fixture.tracks,
        items: fixture.items,
        transcriptSegmentsByMediaId: fixture.transcriptSegmentsByMediaId,
        visualMomentsByMediaId: fixture.visualMomentsByMediaId,
      })

      expect(summary.projectId).toBe('longform-project-45m')
      expect(summary.durationSec).toBe(2700)
      expect(summary.fps).toBe(30)
      expect(summary.resolution.aspectRatio).toBe('16:9')
      expect(summary.tracks.total).toBe(4)
      expect(summary.tracks.byKind.video).toBe(2)
      expect(summary.tracks.byKind.audio).toBe(1)
      expect(summary.tracks.byKind.text).toBe(1)
      expect(summary.itemCounts.total).toBe(180 + 180 + 36) // 396 items
      expect(summary.speechOverview.transcriptAvailable).toBe(true)
      expect(summary.speechOverview.totalWords).toBe(180 * 20) // 3,600 words
      expect(summary.speechOverview.speakerCount).toBe(2)
      expect(summary.visualOverview.visualAnalysisAvailable).toBe(true)
      expect((summary as any).items).toBeUndefined() // Confirms NO giant arrays returned
    })
  })

  describe('Step 5 — video_get_timeline_window', () => {
    it('strictly slices items and transcript tokens within the requested 30s window', () => {
      const fixture = create45MinLongFormFixture()
      // Request 10:00 to 10:30 (600s to 630s)
      const windowResult = buildTimelineWindow({
        projectId: fixture.projectId,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        options: {
          startSec: 600,
          endSec: 630,
          detailLevel: 'standard',
          includeTranscript: true,
          includeVisual: true,
        },
        tracks: fixture.tracks,
        items: fixture.items,
        transcriptTokens: fixture.transcriptTokens,
        visualMomentsByMediaId: fixture.visualMomentsByMediaId,
      })

      expect(windowResult.window.startSec).toBe(600)
      expect(windowResult.window.endSec).toBe(630)
      expect(windowResult.window.durationSec).toBe(30)

      // Only clips in [600s, 630s] should be returned (clips 40 and 41)
      expect(windowResult.items.length).toBeGreaterThan(0)
      expect(windowResult.items.length).toBeLessThanOrEqual(6) // 2 video + 2 audio + 1-2 text
      for (const item of windowResult.items) {
        expect(item.timelineStartSec).toBeLessThan(630)
        expect(item.timelineEndSec).toBeGreaterThan(600)
      }

      // Transcript tokens strictly in [600s, 630s]
      expect(windowResult.transcriptWords).toBeDefined()
      expect(windowResult.transcriptWords!.length).toBeGreaterThan(0)
      for (const word of windowResult.transcriptWords!) {
        expect(word.timelineStartSec).toBeLessThan(630)
        expect(word.timelineEndSec).toBeGreaterThan(600)
      }

      expect(windowResult.truncation.isTruncated).toBe(false)
      expect(windowResult.provenance.transcriptAvailable).toBe(true)
    })

    it('caps max window duration at 300 seconds (5 minutes)', () => {
      const fixture = create45MinLongFormFixture()
      const windowResult = buildTimelineWindow({
        projectId: fixture.projectId,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        options: {
          startSec: 0,
          endSec: 2000, // requests 2000 seconds
        },
        tracks: fixture.tracks,
        items: fixture.items,
      })

      expect(windowResult.window.durationSec).toBe(300) // strictly capped at 300s
      expect(windowResult.window.endSec).toBe(300)
    })
  })

  describe('Step 11 — Payload Size Measurements & Token Efficiency', () => {
    it('proves dramatic payload reduction for long-form project access', () => {
      const fixture = create45MinLongFormFixture()

      // 1. Full project serialization (simulating video_get_project)
      const fullProjectDump = JSON.stringify({
        id: fixture.projectId,
        name: fixture.projectName,
        revision: fixture.projectRevision,
        items: fixture.items,
        tracks: fixture.tracks,
        transcriptTokens: fixture.transcriptTokens,
      })

      // 2. Project summary (video_get_project_summary)
      const summary = buildProjectSummary({
        projectId: fixture.projectId,
        projectName: fixture.projectName,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        width: fixture.width,
        height: fixture.height,
        tracks: fixture.tracks,
        items: fixture.items,
        transcriptSegmentsByMediaId: fixture.transcriptSegmentsByMediaId,
        visualMomentsByMediaId: fixture.visualMomentsByMediaId,
      })
      const summaryDump = JSON.stringify(summary)

      // 3. 30-second window (video_get_timeline_window start=600 end=630)
      const window30s = buildTimelineWindow({
        projectId: fixture.projectId,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        options: { startSec: 600, endSec: 630, includeTranscript: true, includeVisual: true },
        tracks: fixture.tracks,
        items: fixture.items,
        transcriptTokens: fixture.transcriptTokens,
        visualMomentsByMediaId: fixture.visualMomentsByMediaId,
      })
      const window30sDump = JSON.stringify(window30s)

      // 4. 2-minute window (video_get_timeline_window start=600 end=720)
      const window2m = buildTimelineWindow({
        projectId: fixture.projectId,
        projectRevision: fixture.projectRevision,
        fps: fixture.fps,
        options: { startSec: 600, endSec: 720, includeTranscript: true, includeVisual: true },
        tracks: fixture.tracks,
        items: fixture.items,
        transcriptTokens: fixture.transcriptTokens,
        visualMomentsByMediaId: fixture.visualMomentsByMediaId,
      })
      const window2mDump = JSON.stringify(window2m)

      const fullBytes = new TextEncoder().encode(fullProjectDump).length
      const summaryBytes = new TextEncoder().encode(summaryDump).length
      const window30sBytes = new TextEncoder().encode(window30sDump).length
      const window2mBytes = new TextEncoder().encode(window2mDump).length

      // Approximate tokens (~4 bytes per token for JSON)
      const fullTokens = Math.round(fullBytes / 4)
      const summaryTokens = Math.round(summaryBytes / 4)
      const window30sTokens = Math.round(window30sBytes / 4)
      const window2mTokens = Math.round(window2mBytes / 4)

      console.log('--- PAYLOAD COMPARISON (45-MIN PROJECT) ---')
      console.log(`1. Full Project Dump:     ${fullBytes} bytes (~${fullTokens} tokens) | ${fixture.items.length} items`)
      console.log(`2. Project Summary:       ${summaryBytes} bytes (~${summaryTokens} tokens) | 0 items`)
      console.log(`3. 30s Window (600-630s): ${window30sBytes} bytes (~${window30sTokens} tokens) | ${window30s.items.length} items`)
      console.log(`4. 2m Window (600-720s):  ${window2mBytes} bytes (~${window2mTokens} tokens) | ${window2m.items.length} items`)

      // Assertions
      expect(summaryBytes).toBeLessThan(1500) // Summary stays < 1.5 KB
      expect(summaryTokens).toBeLessThan(400) // Summary stays < 400 tokens
      expect(summaryBytes).toBeLessThan(fullBytes / 100) // > 99% reduction vs full dump
      expect(window30sBytes).toBeLessThan(fullBytes / 20) // > 95% reduction vs full dump
    })
  })
})
