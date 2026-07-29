import { memo } from 'react'
import type { TimelineItem as TimelineItemType } from '@/types/timeline'
import { TimelineItem } from './timeline-item'
import { TimelineJoinIndicatorsZoomGate } from './timeline-item/join-indicators'
import { useTimelineStore } from '../stores/timeline-store'
import { useSettledZoomStore } from '../stores/zoom-store'
import { isTimelineItemCompactAtZoom } from '../utils/timeline-dom-density'

interface TimelineTrackItemsProps {
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
  trackItems,
  trackLocked,
  trackHidden,
}: TimelineTrackItemsProps) {
  const fps = useTimelineStore((state) => state.fps)
  const settledPixelsPerSecond = useSettledZoomStore((state) => state.contentPixelsPerSecond)

  return (
    <TimelineJoinIndicatorsZoomGate>
      {trackItems.map((item) => (
        <TimelineItem
          key={item.id}
          item={item}
          timelineDuration={30}
          trackLocked={trackLocked}
          trackHidden={trackHidden}
          isCompactWidth={isTimelineItemCompactAtZoom(
            item.durationInFrames,
            fps,
            settledPixelsPerSecond,
          )}
        />
      ))}
    </TimelineJoinIndicatorsZoomGate>
  )
})
