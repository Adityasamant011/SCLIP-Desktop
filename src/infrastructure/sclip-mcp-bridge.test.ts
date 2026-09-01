import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import type { MediaMetadata } from '@/types/storage'

describe('SCLIP MCP Bridge Tool Handlers Verification', () => {
  const testProjectId = 'mcp-acceptance-project'

  beforeEach(() => {
    useProjectStore.setState({
      currentProject: {
        id: testProjectId,
        metadata: {
          name: 'MCP Test Project',
          description: 'Bridge Testing',
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
      ],
      items: [],
      fps: 30,
      isDirty: false,
      saveTimeline: vi.fn().mockResolvedValue(undefined),
      loadTimeline: vi.fn().mockResolvedValue(undefined),
    } as any)

    useMediaLibraryStore.setState({
      currentProjectId: testProjectId,
      mediaItems: [],
      mediaById: {},
      selectedMediaIds: [],
      importingIds: [],
      setCurrentProject: vi.fn().mockImplementation(async (id) => {
        useMediaLibraryStore.setState({ currentProjectId: id })
      }),
      loadMediaItems: vi.fn().mockResolvedValue(undefined),
    } as any)
  })

  it('verifies media resolution and timeline addition via video_add_clip flow', async () => {
    const mediaItem: MediaMetadata = {
      id: 'clip-alpha',
      fileName: 'hero_shot.mp4',
      fileSize: 50 * 1024 * 1024,
      fileLastModified: Date.now(),
      mimeType: 'video/mp4',
      duration: 10.0,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      bitrate: 8000000,
      storageType: 'handle',
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useMediaLibraryStore.setState({
      mediaItems: [mediaItem],
      mediaById: { [mediaItem.id]: mediaItem },
    })

    // Simulate video_add_clip execution
    const mediaStore = useMediaLibraryStore.getState()
    const media = mediaStore.mediaById['clip-alpha']
    expect(media).toBeDefined()
    expect(media.fileName).toBe('hero_shot.mp4')

    const { addItem } = useTimelineStore.getState()
    const { buildDroppedMediaTimelineItem } = await import('@/features/timeline/utils/dropped-media')
    const { getMediaType } = await import('@/features/media-library/utils/validation')

    const mediaType = getMediaType(media.mimeType)
    const item = buildDroppedMediaTimelineItem({
      media,
      mediaId: media.id,
      mediaType,
      label: media.fileName,
      timelineFps: 30,
      blobUrl: '',
      canvasWidth: 1920,
      canvasHeight: 1080,
      placement: {
        trackId: 'track-v1',
        from: 0,
        durationInFrames: 300,
      },
    })

    addItem(item)

    const timeline = useTimelineStore.getState()
    expect(timeline.items.length).toBe(1)
    expect(timeline.items[0].id).toBe(item.id)
    expect(timeline.items[0].trackId).toBe('track-v1')
    expect(timeline.items[0].from).toBe(0)
    expect(timeline.items[0].durationInFrames).toBe(300)
  })
})
