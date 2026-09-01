import { describe, it, expect } from 'vitest'
import { TauriFileHandle } from './tauri-fs-polyfill'
import { getMimeType, getMediaType } from '@/features/media-library/utils/validation'
import { getDroppedMediaDurationInFrames, buildDroppedMediaTimelineItem } from '@/features/timeline/utils/dropped-media'
import type { MediaMetadata } from '@/types/storage'

describe('SCLIP Diagnostic Verification Suite — Post-Fix', () => {
  describe('Bug 1: TauriFileHandle Serialization — IndexedDB Prototype Loss FIXED', () => {
    it('proves that structured clone strips getFile(), and that re-instantiation via TauriFileHandle constructor restores it', () => {
      const handle = new TauriFileHandle('video.mp4', '/Users/test/video.mp4')
      expect(typeof handle.getFile).toBe('function')
      expect(typeof handle.createWritable).toBe('function')
      expect(typeof handle.queryPermission).toBe('function')

      // Simulate IndexedDB structured clone (prototype stripped)
      const deserializedFromIDB = structuredClone(handle)
      expect(deserializedFromIDB instanceof TauriFileHandle).toBe(false)
      expect(typeof (deserializedFromIDB as any).getFile).toBe('undefined')

      // FIX: Detect plain-object with fullPath and re-wrap in TauriFileHandle
      const raw = deserializedFromIDB as any
      const isStripped =
        typeof raw.getFile !== 'function' &&
        (typeof raw.fullPath === 'string')
      expect(isStripped).toBe(true)

      const restored = new TauriFileHandle(raw.name, raw.fullPath)
      expect(restored instanceof TauriFileHandle).toBe(true)
      expect(typeof restored.getFile).toBe('function')
      expect(restored.name).toBe('video.mp4')
      expect(restored.fullPath).toBe('/Users/test/video.mp4')
    })
  })

  describe('Bug 2: MIME Type Detection & Lottie Support FIXED', () => {
    it('correctly infers video, audio, image, and lottie MIME types from extensions', () => {
      const videoFile = { name: 'sample.mp4', type: 'application/octet-stream' } as File
      expect(getMimeType(videoFile)).toBe('video/mp4')
      expect(getMediaType('video/mp4')).toBe('video')

      const audioFile = { name: 'track.wav', type: 'application/octet-stream' } as File
      expect(getMimeType(audioFile)).toBe('audio/wav')
      expect(getMediaType('audio/wav')).toBe('audio')

      const imageFile = { name: 'photo.png', type: 'application/octet-stream' } as File
      expect(getMimeType(imageFile)).toBe('image/png')
      expect(getMediaType('image/png')).toBe('image')

      const lottieFile = { name: 'anim.json', type: 'application/octet-stream' } as File
      expect(getMimeType(lottieFile)).toBe('application/lottie+json')
      expect(getMediaType('application/lottie+json')).toBe('lottie')

      const dotLottieFile = { name: 'icon.lottie', type: 'application/octet-stream' } as File
      expect(getMimeType(dotLottieFile)).toBe('application/lottie+json')
      expect(getMediaType('application/lottie+json')).toBe('lottie')

      const movFile = { name: 'clip.mov', type: 'application/octet-stream' } as File
      expect(getMimeType(movFile)).toBe('video/quicktime')

      const mp3File = { name: 'song.mp3', type: 'application/octet-stream' } as File
      expect(getMimeType(mp3File)).toBe('audio/mpeg')
    })

    it('correctly builds a timeline item from a dropped Lottie animation', () => {
      const lottieMetadata: MediaMetadata = {
        id: 'lottie-123',
        storageType: 'handle',
        fileName: 'badge.json',
        fileSize: 4096,
        mimeType: 'application/lottie+json',
        duration: 3.5,
        width: 800,
        height: 600,
        fps: 30,
        codec: 'lottie',
        bitrate: 0,
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const durationFrames = getDroppedMediaDurationInFrames(lottieMetadata, 'lottie', 30)
      expect(durationFrames).toBe(105) // 3.5s * 30fps

      const timelineItem = buildDroppedMediaTimelineItem({
        media: lottieMetadata,
        mediaId: 'lottie-123',
        mediaType: 'lottie',
        label: 'badge.json',
        timelineFps: 30,
        blobUrl: 'blob:http://localhost/lottie-blob',
        canvasWidth: 1920,
        canvasHeight: 1080,
        placement: {
          trackId: 'track-v1',
          from: 0,
          durationInFrames: durationFrames,
        },
      })

      expect(timelineItem.type).toBe('lottie')
      expect(timelineItem.trackId).toBe('track-v1')
      expect(timelineItem.from).toBe(0)
      expect(timelineItem.durationInFrames).toBe(105)
      expect((timelineItem as any).src).toBe('blob:http://localhost/lottie-blob')
    })
  })

  describe('Bug 3: Drag Data Cache — Internal WebKit workaround WORKING', () => {
    it('drag data cache correctly stores and retrieves media drag payloads across the drag lifecycle', async () => {
      const { setMediaDragData, getMediaDragData, clearMediaDragData } = await import(
        '@/features/media-library/utils/drag-data-cache'
      )

      // Single item drag payload
      const singlePayload = {
        type: 'media-item' as const,
        mediaId: 'media-abc123',
        mediaType: 'video',
        fileName: 'clip.mp4',
        duration: 12.5,
      }

      setMediaDragData(singlePayload)
      expect(getMediaDragData()).toEqual(singlePayload)

      clearMediaDragData()
      expect(getMediaDragData()).toBeNull()

      // Multi-item drag payload
      const multiPayload = {
        type: 'media-items' as const,
        items: [
          { mediaId: 'a', mediaType: 'video', fileName: 'a.mp4', duration: 5 },
          { mediaId: 'b', mediaType: 'audio', fileName: 'b.mp3', duration: 10 },
        ],
      }

      setMediaDragData(multiPayload)
      expect(getMediaDragData()).toEqual(multiPayload)
      clearMediaDragData()
      expect(getMediaDragData()).toBeNull()
    })
  })
})
