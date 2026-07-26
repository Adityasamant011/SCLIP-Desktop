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
export function collectSourceRangeFindings(
  items: readonly TimelineItem[],
  mediaById: ReadonlyMap<string, MediaMetadata>,
  projectFps: number,
): SourceRangeFinding[] {
  const findings: SourceRangeFinding[] = []
  for (const item of items) {
    if (item.type !== 'video' && item.type !== 'audio') continue
    const mediaId = (item as { mediaId?: string }).mediaId
    if (!mediaId) continue
    const metadata = mediaById.get(mediaId)
    if (!metadata || !(metadata.duration > 0)) continue

    const sourceFps = metadata.fps > 0 ? metadata.fps : projectFps
    const speed = (item as { speed?: number }).speed ?? 1
    const sourceStart = (item as { sourceStart?: number }).sourceStart ?? 0
    const sourceEnd =
      (item as { sourceEnd?: number }).sourceEnd ??
      sourceStart + (item.durationInFrames * speed * sourceFps) / projectFps

    const neededSeconds = sourceEnd / sourceFps
    // Half a frame + a small epsilon of slack: metadata durations are rounded.
    const tolerance = Math.max(0.05, 0.5 / sourceFps)
    if (neededSeconds > metadata.duration + tolerance) {
      findings.push({
        itemId: item.id,
        mediaId,
        neededSeconds,
        availableSeconds: metadata.duration,
      })
    }
  }
  return findings
}
