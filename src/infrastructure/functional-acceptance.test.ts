import { describe, it, expect, beforeEach } from 'vitest'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { buildDroppedMediaTimelineItem } from '@/features/timeline/utils/dropped-media'
import { getMediaType } from '@/features/media-library/utils/validation'
import type { MediaMetadata } from '@/types/storage'

describe('SCLIP Step 1: Functional Acceptance End-to-End Pipeline', () => {
  const testProjectId = 'test-project-acceptance-01'

  beforeEach(() => {
    useProjectStore.setState({
      currentProject: {
        id: testProjectId,
        metadata: {
          name: 'Acceptance Test Project',
          description: 'E2E Validation',
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 10,
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
      currentProjectId: testProjectId,
      mediaItems: [],
      mediaById: {},
      selectedMediaIds: [],
      importingIds: [],
    })
  })

  it('verifies video_add_clip: media resolution -> Zustand mutation -> persistence readiness', async () => {
    // 1. Stage a realistic video media item in the store
    const sampleMedia: MediaMetadata = {
      id: 'media-clip-101',
      fileName: 'scene_01.mp4',
      fileSize: 1024 * 1024 * 15,
      fileLastModified: Date.now(),
      mimeType: 'video/mp4',
      duration: 5.0, // 5 seconds = 150 frames @ 30fps
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      bitrate: 5000000,
      storageType: 'handle',
      tags: ['intro'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useMediaLibraryStore.setState((state) => ({
      mediaItems: [sampleMedia],
      mediaById: { [sampleMedia.id]: sampleMedia },
    }))

    // 2. Resolve media from library (what video_add_clip does)
    const mediaStore = useMediaLibraryStore.getState()
    const resolvedMedia = mediaStore.mediaById[sampleMedia.id]
    expect(resolvedMedia).toBeDefined()
    expect(resolvedMedia.fileName).toBe('scene_01.mp4')

    // 3. Build Timeline Item using production builder
    const mediaType = getMediaType(resolvedMedia.mimeType)
    expect(mediaType).toBe('video')

    const timelineItem = buildDroppedMediaTimelineItem({
      media: resolvedMedia,
      mediaId: resolvedMedia.id,
      mediaType,
      label: resolvedMedia.fileName,
      timelineFps: 30,
      blobUrl: 'blob:http://localhost/mock-video-blob',
      canvasWidth: 1920,
      canvasHeight: 1080,
      placement: {
        trackId: 'track-v1',
        from: 0,
        durationInFrames: 150,
      },
    })

    expect(timelineItem).toBeDefined()
    expect(timelineItem.trackId).toBe('track-v1')
    expect(timelineItem.from).toBe(0)
    expect(timelineItem.durationInFrames).toBe(150)
    expect(timelineItem.type).toBe('video')

    // 4. Mutate Zustand Timeline Store
    const { addItem } = useTimelineStore.getState()
    addItem(timelineItem)

    const updatedTimeline = useTimelineStore.getState()
    expect(updatedTimeline.items.length).toBe(1)
    expect(updatedTimeline.items[0].id).toBe(timelineItem.id)
    expect(updatedTimeline.items[0].label).toBe('scene_01.mp4')
    expect(updatedTimeline.isDirty).toBe(true)

    // 5. Test Split Operation (Hermes Agent tool: video_split_clip)
    const splitFrame = 60 // 2 seconds in
    const { splitItemAtFrame } = useTimelineStore.getState()
    
    // Perform split if supported by store action
    if (typeof splitItemAtFrame === 'function') {
      splitItemAtFrame(timelineItem.id, splitFrame)
      const postSplitTimeline = useTimelineStore.getState()
      expect(postSplitTimeline.items.length).toBe(2)
      expect(postSplitTimeline.items[0].from).toBe(0)
      expect(postSplitTimeline.items[0].durationInFrames).toBe(60)
      expect(postSplitTimeline.items[1].from).toBe(60)
      expect(postSplitTimeline.items[1].durationInFrames).toBe(90)
    }

    // 6. Verify Project Snapshot Generation for persistence
    const projectSnapshot = {
      ...useProjectStore.getState().currentProject!,
      timeline: {
        tracks: useTimelineStore.getState().tracks,
        items: useTimelineStore.getState().items,
        markers: [],
        transitions: [],
      },
    }

    expect(projectSnapshot.timeline.items.length).toBeGreaterThanOrEqual(1)
    expect(projectSnapshot.metadata.name).toBe('Acceptance Test Project')
  })

  it('verifies Lottie timeline insertion and frame metadata accuracy', () => {
    const lottieMedia: MediaMetadata = {
      id: 'lottie-anim-202',
      fileName: 'motion_graphic.json',
      fileSize: 45000,
      fileLastModified: Date.now(),
      mimeType: 'application/lottie+json',
      duration: 4.0, // 120 frames @ 30fps
      width: 1080,
      height: 1080,
      fps: 30,
      codec: 'lottie',
      bitrate: 0,
      storageType: 'handle',
      tags: ['overlay'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useMediaLibraryStore.setState({
      mediaItems: [lottieMedia],
      mediaById: { [lottieMedia.id]: lottieMedia },
    })

    const mediaType = getMediaType(lottieMedia.mimeType)
    expect(mediaType).toBe('lottie')

    const lottieItem = buildDroppedMediaTimelineItem({
      media: lottieMedia,
      mediaId: lottieMedia.id,
      mediaType,
      label: lottieMedia.fileName,
      timelineFps: 30,
      blobUrl: 'blob:http://localhost/mock-lottie-blob',
      canvasWidth: 1920,
      canvasHeight: 1080,
      placement: {
        trackId: 'track-v1',
        from: 30,
        durationInFrames: 120,
      },
    })

    expect(lottieItem.type).toBe('lottie')
    expect(lottieItem.trackId).toBe('track-v1')
    expect(lottieItem.from).toBe(30)
    expect(lottieItem.durationInFrames).toBe(120)

    useTimelineStore.getState().addItem(lottieItem)
    expect(useTimelineStore.getState().items.length).toBe(1)
    expect(useTimelineStore.getState().items[0].type).toBe('lottie')
  })
})
