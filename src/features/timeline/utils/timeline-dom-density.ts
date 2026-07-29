/**
 * Dense-track policy is based on the full track size, never the viewport
 * subset. That keeps DOM/detail/culling behavior stable while zoom changes
 * which clips happen to overlap the mounted range.
 */
export const DENSE_TIMELINE_TRACK_ITEM_THRESHOLD = 80

export const DEFAULT_TIMELINE_ITEM_CULL_BUFFER_PX = 2000
export const DENSE_TIMELINE_ITEM_CULL_BUFFER_PX = 600
export const COMPACT_TIMELINE_ITEM_MAX_WIDTH_PX = 36

export function getTimelineItemCullBufferPx(trackItemCount: number): number {
  return trackItemCount >= DENSE_TIMELINE_TRACK_ITEM_THRESHOLD
    ? DENSE_TIMELINE_ITEM_CULL_BUFFER_PX
    : DEFAULT_TIMELINE_ITEM_CULL_BUFFER_PX
}

export function isTimelineItemCompactAtZoom(
  durationInFrames: number,
  fps: number,
  pixelsPerSecond: number,
): boolean {
  if (durationInFrames <= 0 || fps <= 0 || pixelsPerSecond <= 0) return false
  const width = Math.round((durationInFrames / fps) * pixelsPerSecond)
  return width <= COMPACT_TIMELINE_ITEM_MAX_WIDTH_PX
}
