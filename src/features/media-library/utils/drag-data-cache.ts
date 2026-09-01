import type { VisualEffect } from '@/types/effects'
import type { TextStylePresetId } from '@/shared/typography/text-style-presets'

/**
 * Cache for media drag data
 *
 * This module provides a way to share drag data between the media library
 * and timeline components. This is necessary because dataTransfer.getData()
 * is not accessible during dragover events for security reasons.
 */

interface DragMediaItem {
  mediaId: string
  mediaType: string
  fileName: string
  duration: number
}

interface MediaDragData {
  type: 'media-item' | 'media-items'
  items?: DragMediaItem[]
  mediaId?: string
  mediaType?: string
  fileName?: string
  duration?: number
}

export interface CompositionDragData {
  type: 'composition'
  compositionId: string
  name: string
  durationInFrames: number
  width: number
  height: number
}

export interface TimelineTemplateDragData {
  type: 'timeline-template'
  itemType: 'text' | 'shape' | 'adjustment'
  label: string
  textStylePresetId?: TextStylePresetId
  shapeType?:
    | 'rectangle'
    | 'circle'
    | 'triangle'
    | 'ellipse'
    | 'star'
    | 'polygon'
    | 'heart'
    | 'path'
  effects?: VisualEffect[]
}

export type DragData = MediaDragData | CompositionDragData | TimelineTemplateDragData

/**
 * Pointer drags in WKWebView do not always produce a usable HTML5 `drop`
 * event. This event deliberately bypasses DataTransfer and is consumed by a
 * concrete classic-timeline track, which still uses the normal placement
 * planner and timeline store mutation.
 */
export const SCLIP_MEDIA_POINTER_DROP_EVENT = 'sclip:media-pointer-drop'

export interface SclipMediaPointerDropDetail {
  payload: DragData
  clientX: number
  clientY: number
}

const TIMELINE_EXTERNAL_MEDIA_DRAG_CLASS = 'timeline-external-media-drag'

let cachedDragData: DragData | null = null
let deferredClearTimer: number | null = null

function shouldEnableTimelinePointerPassthrough(data: DragData | null): boolean {
  return data?.type === 'media-item' || data?.type === 'media-items' || data?.type === 'composition'
}

function syncTimelinePointerPassthrough(data: DragData | null): void {
  if (typeof document === 'undefined') {
    return
  }

  document.body.classList.toggle(
    TIMELINE_EXTERNAL_MEDIA_DRAG_CLASS,
    shouldEnableTimelinePointerPassthrough(data),
  )
}

export function setMediaDragData(data: DragData): void {
  if (deferredClearTimer !== null) {
    window.clearTimeout(deferredClearTimer)
    deferredClearTimer = null
  }
  cachedDragData = data
  syncTimelinePointerPassthrough(data)
}

export function getMediaDragData(): DragData | null {
  return cachedDragData
}

export function clearMediaDragData(): void {
  if (deferredClearTimer !== null) {
    window.clearTimeout(deferredClearTimer)
    deferredClearTimer = null
  }
  cachedDragData = null
  syncTimelinePointerPassthrough(null)
}

/**
 * WebKit can send `dragend` before the target's React `drop` callback. Keep
 * the in-memory payload alive for the target event, then promptly remove it
 * so a later unrelated external-file drop cannot reuse stale media.
 */
export function deferMediaDragDataCleanup(delayMs = 250): void {
  if (typeof window === 'undefined') {
    clearMediaDragData()
    return
  }
  if (deferredClearTimer !== null) window.clearTimeout(deferredClearTimer)
  deferredClearTimer = window.setTimeout(() => {
    deferredClearTimer = null
    cachedDragData = null
    syncTimelinePointerPassthrough(null)
  }, delayMs)
}
