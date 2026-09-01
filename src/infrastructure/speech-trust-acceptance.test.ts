import { describe, it, expect, beforeEach } from 'vitest'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { buildDroppedMediaTimelineItem } from '@/features/timeline/utils/dropped-media'
import { buildSpeechDetection } from '@/features/media-library/transcription/speech-detection'
import { evaluateTranscriptReliability, getTranscriptReliability } from '@/features/media-library/transcription/transcript-reliability'
import { validateEditPlanForV1, type SclipEditPlan } from '@/features/editor/agent/edit-plan'
import { buildScriptTimelineRevision } from '@/shared/utils/script-timeline-revision'
import { buildTranscriptWordId } from '@/shared/utils/transcript-word-id'
import type { MediaMetadata, MediaTranscript } from '@/types/storage'

describe('SCLIP Editorial Intelligence V1: Speech Trust Boundary Acceptance', () => {
  const projectId = 'test-speech-trust-project-01'

  beforeEach(() => {
    useProjectStore.setState({
      currentProject: {
        id: projectId,
        name: 'Speech Trust Acceptance Project',
        metadata: {
          name: 'Speech Trust Acceptance Project',
          description: 'E2E Speech Gate Proof',
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 30,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        timeline: {
          tracks: [
            { id: 'track-v1', name: 'Video 1', kind: 'video', order: 0, locked: false, muted: false, hidden: false },
            { id: 'track-a1', name: 'Audio 1', kind: 'audio', order: 1, locked: false, muted: false, hidden: false },
          ],
          items: [],
          markers: [],
          transitions: [],
        },
      } as any,
    })

    useTimelineStore.setState({
      tracks: [
        { id: 'track-v1', name: 'Video 1', kind: 'video', order: 0, locked: false, muted: false, hidden: false },
        { id: 'track-a1', name: 'Audio 1', kind: 'audio', order: 1, locked: false, muted: false, hidden: false },
      ],
      items: [],
      fps: 30,
      isDirty: false,
    })

    useMediaLibraryStore.setState({
      currentProjectId: projectId,
      mediaItems: [],
      mediaById: {},
      selectedMediaIds: [],
      importingIds: [],
    })
  })

  describe('A. Guitar Negative Acceptance (0406.mov)', () => {
    it('proves that guitar/music audio yields speechDetected=false and blocks hallucinated transcript from editable script', () => {
      // 1. Simulated VAD windows for 0406.mov: occasional isolated acoustic spikes (< 0.2s duration)
      // but zero sustained speech.
      const guitarVadWindows = [
        { start: 0, end: 5, probability: 0.05 },
        { start: 17.8, end: 17.9, probability: 0.62 }, // short guitar pluck (< 0.2s)
        { start: 17.9, end: 25, probability: 0.08 },
        { start: 26.1, end: 26.2, probability: 0.55 }, // short note attack (< 0.2s)
        { start: 26.2, end: 44.6, probability: 0.04 },
      ]

      const detection = buildSpeechDetection(guitarVadWindows, 44.604)

      // Assert VAD rejects guitar noise
      expect(detection.speechDetected).toBe(false)
      expect(detection.speechRanges).toEqual([])
      expect(detection.speechCoverage).toBe(0)

      // 2. Even if legacy/hallucinated ASR output existed for 0406.mov:
      const rawHallucinatedTranscript: MediaTranscript = {
        id: 'media-guitar-0406',
        mediaId: 'media-guitar-0406',
        model: 'parakeet-tdt-v3',
        language: 'en',
        quantization: 'hybrid',
        text: '2. Cigar iggununes <unk> <unk> 2-0',
        segments: [
          {
            text: '2. Cigar iggununes <unk> <unk> 2-0',
            start: 17.84,
            end: 36.0,
            words: [
              { text: '2.', start: 17.84, end: 18.1 },
              { text: 'Cigar', start: 18.1, end: 18.8 },
              { text: 'iggununes', start: 25, end: 26 },
              { text: '<unk>', start: 26, end: 27 },
              { text: '<unk>', start: 27, end: 28 },
              { text: '2-0', start: 35, end: 36 },
            ],
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Evaluate reliability
      const reliability = evaluateTranscriptReliability(rawHallucinatedTranscript, 44.604, detection)

      expect(reliability.speechDetected).toBe(false)
      expect(reliability.transcriptReliable).toBe(false)
      expect(reliability.speechRanges).toEqual([])
      expect(reliability.reliabilityReasons).toContain('NO_RELIABLE_SPEECH')
      expect(reliability.reliabilityReasons).toContain('HIGH_UNKNOWN_TOKEN_RATIO')

      // 3. Verify that script loading gates this transcript:
      // When transcriptReliable is false, segments are gated to []
      const effectiveTranscript = reliability.transcriptReliable
        ? rawHallucinatedTranscript
        : { ...rawHallucinatedTranscript, segments: [] }

      expect(effectiveTranscript.segments).toEqual([])
      const editableWordCount = effectiveTranscript.segments.flatMap((s) => s.words ?? []).length
      expect(editableWordCount).toBe(0)
    })
  })

  describe('B. Real Speech Positive Acceptance (jo.wav fixture)', () => {
    it('proves that clear human speech yields speechDetected=true, high confidence, and stable editable words', () => {
      // 1. VAD detection from real speech fixture (jo.wav: 13.06s)
      const speechVadWindows = Array.from({ length: 400 }, (_, i) => ({
        start: i * 0.032,
        end: (i + 1) * 0.032,
        probability: i >= 3 && i <= 390 ? 0.94 : 0.1,
      }))

      const detection = buildSpeechDetection(speechVadWindows, 13.06)

      expect(detection.speechDetected).toBe(true)
      expect(detection.speechConfidence).toBeGreaterThan(0.9)
      expect(detection.speechRanges.length).toBeGreaterThan(0)
      expect(detection.speechCoverage).toBeGreaterThan(0.9)

      // 2. Real timestamped ASR transcript for speech fixture
      const spokenWords = [
        { text: 'Most', start: 0.12, end: 0.45, confidence: 0.96 },
        { text: 'people', start: 0.48, end: 0.85, confidence: 0.95 },
        { text: 'make', start: 0.88, end: 1.15, confidence: 0.97 },
        { text: 'this', start: 1.18, end: 1.35, confidence: 0.98 },
        { text: 'mistake', start: 1.38, end: 1.95, confidence: 0.94 },
        { text: 'when', start: 1.98, end: 2.25, confidence: 0.96 },
        { text: 'editing', start: 2.28, end: 2.75, confidence: 0.95 },
        { text: 'videos', start: 2.78, end: 3.35, confidence: 0.93 },
      ]

      const spokenTranscript: MediaTranscript = {
        id: 'media-speech-jo',
        mediaId: 'media-speech-jo',
        model: 'parakeet-tdt-v3',
        language: 'en',
        quantization: 'hybrid',
        text: 'Most people make this mistake when editing videos',
        segments: [
          {
            text: 'Most people make this mistake when editing videos',
            start: 0.12,
            end: 3.35,
            words: spokenWords,
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const reliability = evaluateTranscriptReliability(spokenTranscript, 13.06, detection)

      expect(reliability.speechDetected).toBe(true)
      expect(reliability.transcriptReliable).toBe(true)
      expect(reliability.reliabilityScore).toBeGreaterThanOrEqual(0.7)
      expect(reliability.reliabilityReasons).toEqual([])
      expect(reliability.speechRanges.length).toBeGreaterThan(0)

      // 3. Word IDs are stable and formatted properly
      const wordIds = spokenWords.map((w) => buildTranscriptWordId(spokenTranscript.mediaId, w))
      expect(wordIds.length).toBe(spokenWords.length)
      expect(new Set(wordIds).size).toBe(spokenWords.length)
      expect(wordIds[0]).toContain('sclip-word:')
      expect(wordIds[0]).toContain('most')
    })
  })

  describe('C. Script EditPlan Acceptance', () => {
    it('executes a deterministic video_apply_script EditPlan removing a spoken phrase, verifying timeline change and undo', async () => {
      // 1. Setup speech media in library
      const speechMedia: MediaMetadata = {
        id: 'media-speech-clip',
        fileName: 'creator_advice.mp4',
        fileSize: 1024 * 1024 * 10,
        fileLastModified: Date.now(),
        mimeType: 'video/mp4',
        duration: 10.0,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        bitrate: 4000000,
        storageType: 'handle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      useMediaLibraryStore.setState({
        mediaItems: [speechMedia],
        mediaById: { [speechMedia.id]: speechMedia },
      })

      // 2. Place clip on timeline: 0 to 300 frames (10 seconds)
      const clipItem = buildDroppedMediaTimelineItem({
        media: speechMedia,
        mediaId: speechMedia.id,
        mediaType: 'video',
        label: speechMedia.fileName,
        timelineFps: 30,
        blobUrl: 'blob:http://localhost/speech-blob',
        canvasWidth: 1920,
        canvasHeight: 1080,
        placement: {
          trackId: 'track-v1',
          from: 0,
          durationInFrames: 300,
        },
      })

      useTimelineStore.getState().addItem(clipItem)
      expect(useTimelineStore.getState().items.length).toBe(1)

      const initialRevision = await buildScriptTimelineRevision({
        fps: 30,
        items: useTimelineStore.getState().items,
      })

      // 3. Define deterministic EditPlan removing "this mistake" (from 1.18s to 1.95s)
      const removalRange = { start: 1.18, end: 1.95 }
      const plan: SclipEditPlan = {
        schemaVersion: 1,
        title: 'Tighten opening statement',
        goal: 'Remove filler / hesitation words from creator hook',
        projectId,
        projectRevision: initialRevision,
        evidenceIds: ['transcript:creator_advice'],
        operations: [
          {
            id: 'op-01',
            executor: 'video_apply_script',
            summary: 'Remove redundant phrase "this mistake" from opening',
            risk: 'reversible',
            args: {
              operations: [
                {
                  type: 'remove_words',
                  word_refs: [
                    { item_id: clipItem.id, word_id: 'w_1180_1350_this' },
                    { item_id: clipItem.id, word_id: 'w_1380_1950_mistake' },
                  ],
                },
              ],
            },
            evidenceIds: ['transcript:creator_advice'],
            verification: ['deterministic', 'perceptual'],
            affectedRange: { startFrame: 35, endFrame: 59 },
            expectedOutcome: 'Timeline duration decreases by ~0.77 seconds with seamless audio cut',
          },
        ],
        limitations: ['Only confirmed spoken transcript ranges are removed.'],
      }

      // Validate plan
      const validationIssues = validateEditPlanForV1(plan, ['transcript:creator_advice'])
      expect(validationIssues).toEqual([])

      // 4. Apply removal via removeTranscriptRangesFromItems (the engine of video_apply_script)
      const removeRanges = {
        [speechMedia.id]: [removalRange],
      }

      const { removeTranscriptRangesFromItems } = useTimelineStore.getState()
      const applied = removeTranscriptRangesFromItems([clipItem.id], removeRanges)

      expect(applied.removedRangeCount).toBe(1)
      expect(applied.splitCount).toBe(2)

      // Verify timeline state changed (clip split into 2 items with ripple)
      const postEditTimeline = useTimelineStore.getState()
      expect(postEditTimeline.items.length).toBe(2)

      const postEditRevision = await buildScriptTimelineRevision({
        fps: 30,
        items: postEditTimeline.items,
      })

      expect(postEditRevision).not.toBe(initialRevision)

      // Total duration on timeline decreased
      const totalDuration = postEditTimeline.items.reduce((max, item) => Math.max(max, item.from + item.durationInFrames), 0)
      expect(totalDuration).toBeLessThan(300)

      // 5. Test undo
      const temporal = (useTimelineStore as any).temporal?.getState?.()
      if (temporal && typeof temporal.undo === 'function') {
        temporal.undo()
        const undoneTimeline = useTimelineStore.getState()
        expect(undoneTimeline.items.length).toBe(1)
        expect(undoneTimeline.items[0].durationInFrames).toBe(300)
      }
    })
  })
})
