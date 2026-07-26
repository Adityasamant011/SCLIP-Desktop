/**
 * Load-time validation helpers for the headless harness.
 *
 * Programmatically-built projects fail in ways the interactive editor can't:
 * nobody is looking at the timeline, so an item that silently renders wrong
 * (or not at all) costs hours of false trails. These checks turn the known
 * silent failures into explicit warnings the driver can log or fail on.
 */
import type { TimelineItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import type { CompositionInputProps } from '@/types/export'

export interface SourceRangeFinding {
  itemId: string
  mediaId: string
  /** Seconds of source material the item's cut requires. */
  neededSeconds: number
  /** Seconds the media actually has (from metadata.json). */
  availableSeconds: number
}

/**
 * Find items whose source cut runs past the end of their media — the engine
 * pads the tail with black frames / silence without any warning.
 *
 * `sourceStart`/`sourceEnd` are in source-native fps (see CLAUDE.md); when
 * `sourceEnd` is absent the needed range is derived from the timeline duration
 * and speed. Media without a known duration is skipped.
 */
function findSourceOverrun(
  item: TimelineItem,
  metadata: MediaMetadata,
  projectFps: number,
): SourceRangeFinding | null {
  const sourceFps = metadata.fps > 0 ? metadata.fps : projectFps
  const speed = (item as { speed?: number }).speed ?? 1
  const sourceStart = (item as { sourceStart?: number }).sourceStart ?? 0
  const sourceEnd =
    (item as { sourceEnd?: number }).sourceEnd ??
    sourceStart + (item.durationInFrames * speed * sourceFps) / projectFps

  const neededSeconds = sourceEnd / sourceFps
  // Half a frame + a small epsilon of slack: metadata durations are rounded.
  const tolerance = Math.max(0.05, 0.5 / sourceFps)
  if (neededSeconds <= metadata.duration + tolerance) return null
  return {
    itemId: item.id,
    mediaId: (item as { mediaId?: string }).mediaId ?? '',
    neededSeconds,
    availableSeconds: metadata.duration,
  }
}

export function collectSourceRangeFindings(
  items: readonly TimelineItem[],
  mediaById: ReadonlyMap<string, MediaMetadata>,
  projectFps: number,
): SourceRangeFinding[] {
  const findings: SourceRangeFinding[] = []
  for (const item of items) {
    if (item.type !== 'video' && item.type !== 'audio') continue
    const mediaId = (item as { mediaId?: string }).mediaId
    const metadata = mediaId ? mediaById.get(mediaId) : undefined
    if (!metadata || !(metadata.duration > 0)) continue
    const finding = findSourceOverrun(item, metadata, projectFps)
    if (finding) findings.push(finding)
  }
  return findings
}

/** Build the mediaId → metadata lookup from the driver's media list. */
export function buildMediaMetadataMap(
  media: Array<{ mediaId: string; metadata?: MediaMetadata }> | undefined,
): Map<string, MediaMetadata> {
  const mediaById = new Map<string, MediaMetadata>()
  for (const m of media ?? []) {
    if (m.metadata) mediaById.set(m.mediaId, m.metadata)
  }
  return mediaById
}

export function videoCarriesAudio(
  videoItem: { embeddedAudioMuted?: boolean; mediaId?: string },
  mediaById: Map<string, MediaMetadata>,
): boolean {
  if (videoItem.embeddedAudioMuted) return false
  const metadata = videoItem.mediaId ? mediaById.get(videoItem.mediaId) : undefined
  // Without metadata assume the video may carry audio; with it require an audio track.
  return !metadata || Boolean(metadata.audioCodec)
}

function itemCanCarryAudio(
  item: CompositionInputProps['tracks'][number]['items'][number],
  mediaById: Map<string, MediaMetadata>,
): boolean {
  if (item.type === 'audio') return true
  return item.type === 'video' && videoCarriesAudio(item, mediaById)
}

/** True when any item on an unmuted, visible track can contribute audio. */
export function hasAudioCapableItems(
  tracks: CompositionInputProps['tracks'],
  mediaById: Map<string, MediaMetadata>,
): boolean {
  return tracks.some(
    (track) =>
      track.visible !== false &&
      track.muted !== true &&
      (track.items ?? []).some((item) => itemCanCarryAudio(item, mediaById)),
  )
}
