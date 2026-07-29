import { memo, useCallback } from 'react'
import type { TimelineItem as TimelineItemType } from '@/types/timeline'
import { TimelineItem } from './timeline-item'
import { TimelineJoinIndicatorsZoomGate } from './timeline-item/join-indicators'
import { useTimelineStore } from '../stores/timeline-store'
import { useZoomStore } from '../stores/zoom-store'
import { useVisibleItemDetailRange } from '../hooks/use-visible-items'
import {
  getDemotionAwarePixelsPerSecond,
  isTimelineItemCompactAtZoom,
} from '../utils/timeline-dom-density'

interface TimelineTrackItemsProps {
  trackId: string
  trackItems: ReadonlyArray<TimelineItemType>
  trackLocked: boolean
  trackHidden: boolean
}

/**
 * Keep one rich DOM item tree mounted for the lifetime of the track. Zoom and
 * density changes are visual concerns handled by the committed track surface;
 * swapping clips for canvas hit targets breaks hover, marquee, and group-drag
 * continuity.
 */
export const TimelineTrackItems = memo(function TimelineTrackItems({
  trackId,
  trackItems,
  trackLocked,
  trackHidden,
}: TimelineTrackItemsProps) {
  const fps = useTimelineStore((state) => state.fps)
  const detailRange = useVisibleItemDetailRange(trackId)
  // Evaluate live zoom cheaply, but publish to React only when the number of
  // compact clips changes. A saturated track therefore demotes during zoom-out
  // without rerendering this list on every intermediate zoom frame.
  const compactCohortSize = useZoomStore(
    useCallback(
      (state) => {
        const pixelsPerSecond = getDemotionAwarePixelsPerSecond(
          state.contentPixelsPerSecond,
          state.pixelsPerSecond,
          state.isZoomInteracting,
        )
        let compactCount = 0
        for (const item of trackItems) {
          if (isTimelineItemCompactAtZoom(item.durationInFrames, fps, pixelsPerSecond)) {
            compactCount += 1
          }
        }
        return compactCount
      },
      [fps, trackItems],
    ),
  )
  const zoomState = useZoomStore.getState()
  const renderPixelsPerSecond = getDemotionAwarePixelsPerSecond(
    zoomState.contentPixelsPerSecond,
    zoomState.pixelsPerSecond,
    zoomState.isZoomInteracting,
  )
  const allItemsCompact = compactCohortSize === trackItems.length
  const noItemsCompact = compactCohortSize === 0

  return (
    <TimelineJoinIndicatorsZoomGate>
      {trackItems.map((item) => {
        const isDetailEligible =
          item.from + item.durationInFrames > detailRange.start && item.from < detailRange.end
        return (
          <TimelineItem
            key={item.id}
            item={item}
            timelineDuration={30}
            trackLocked={trackLocked}
            trackHidden={trackHidden}
            isDetailEligible={isDetailEligible}
            isCompactWidth={
              !isDetailEligible ||
              allItemsCompact ||
              (!noItemsCompact &&
                isTimelineItemCompactAtZoom(
                  item.durationInFrames,
                  fps,
                  renderPixelsPerSecond,
                ))
            }
          />
        )
      })}
    </TimelineJoinIndicatorsZoomGate>
  )
})
