/**
 * Packet-remux eligibility planning.
 *
 * Pure decision logic (moved verbatim from canvas-render-orchestrator.ts) for
 * the export fast path: when the timeline is a single unmodified clip, the
 * source packets can be remuxed directly instead of rendering frame by frame.
 * The actual remux execution stays in the orchestrator.
 */

import type { CompositionInputProps } from '@/types/export'
import type { TimelineTrack, TimelineItem, VideoItem } from '@/types/timeline'
import type { ClientExportSettings } from './client-renderer'
import { hasMediaCrop } from '@/shared/utils/media-crop'

export interface PacketRemuxPlan {
  src: string
  trimStartSeconds: number
  trimEndSeconds: number
  includeAudio: boolean
}

const EPSILON = 1e-6

export function isIdentityTransform(item: VideoItem): boolean {
  const transform = item.transform
  if (hasMediaCrop(item.crop)) return false
  if (!transform) return true

  if (transform.width !== undefined || transform.height !== undefined) return false
  if (transform.x !== undefined && Math.abs(transform.x) > EPSILON) return false
  if (transform.y !== undefined && Math.abs(transform.y) > EPSILON) return false
  if (transform.rotation !== undefined && Math.abs(transform.rotation) > EPSILON) return false
  if (transform.cornerRadius !== undefined && Math.abs(transform.cornerRadius) > EPSILON)
    return false
  if (transform.opacity !== undefined && Math.abs(transform.opacity - 1) > EPSILON) return false
  return true
}

export function getPacketRemuxPlan(
  settings: ClientExportSettings,
  composition: CompositionInputProps,
): PacketRemuxPlan | null {
  if (settings.mode !== 'video') return null
  if (composition.durationInFrames === undefined || composition.durationInFrames <= 0) return null
  if ((composition.transitions?.length ?? 0) > 0) return null
  if ((composition.keyframes?.length ?? 0) > 0) return null

  const tracks: TimelineTrack[] = (composition.tracks ?? []).filter(
    (track) => track.visible !== false,
  )
  const items: Array<{ item: TimelineItem; track: TimelineTrack }> = []

  for (const track of tracks) {
    for (const item of track.items ?? []) {
      if (item.durationInFrames > 0) {
        items.push({ item, track })
      }
    }
  }

  if (items.length !== 1) return null

  const { item, track } = items[0]!
  if (item.type !== 'video') return null

  const videoItem = item as VideoItem
  if (!videoItem.src) return null
  if (videoItem.isReversed === true) return null
  if (videoItem.from !== 0) return null
  if (videoItem.durationInFrames !== composition.durationInFrames) return null
  if ((videoItem.effects?.length ?? 0) > 0) return null
  if (!isIdentityTransform(videoItem)) return null

  const speed = videoItem.speed ?? 1
  if (Math.abs(speed - 1) > EPSILON) return null

  const hasVisualFades =
    Math.abs(videoItem.fadeIn ?? 0) > EPSILON || Math.abs(videoItem.fadeOut ?? 0) > EPSILON
  if (hasVisualFades) return null

  const includeAudio = track.muted !== true
  if (includeAudio) {
    const hasAudioAdjustments =
      Math.abs(videoItem.volume ?? 0) > EPSILON ||
      Math.abs(videoItem.audioFadeIn ?? 0) > EPSILON ||
      Math.abs(videoItem.audioFadeOut ?? 0) > EPSILON
    if (hasAudioAdjustments) return null
  }

  const sourceFps = videoItem.sourceFps ?? composition.fps
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return null
  if (Math.abs((settings.fps ?? composition.fps) - composition.fps) > EPSILON) return null

  // Require clip to start at source frame 0 — a trimmed-from-middle clip can't be
  // remuxed directly and must fall back to frame-by-frame rendering.
  const sourceStartFrames = videoItem.sourceStart ?? videoItem.trimStart ?? videoItem.offset ?? 0
  if (Math.abs(sourceStartFrames) > EPSILON) return null
  const trimStartSeconds = Math.max(0, sourceStartFrames / sourceFps)
  const clipDurationSeconds = videoItem.durationInFrames / composition.fps
  if (!Number.isFinite(clipDurationSeconds) || clipDurationSeconds <= 0) return null

  const trimEndSeconds = trimStartSeconds + clipDurationSeconds
  if (!Number.isFinite(trimEndSeconds) || trimEndSeconds <= trimStartSeconds) return null

  return {
    src: videoItem.src,
    trimStartSeconds,
    trimEndSeconds,
    includeAudio,
  }
}
