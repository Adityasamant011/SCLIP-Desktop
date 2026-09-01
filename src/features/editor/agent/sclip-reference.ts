import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'

function compact(kind: 'item' | 'media' | 'transition', id: string): string {
  // Eight UUID characters are concise while remaining unambiguous within a
  // project. The resolver rejects the reference if it ever finds a collision.
  return `@sclip/${kind}/${id.slice(0, 8)}`
}

/** A pasteable, durable target for an item currently visible in the timeline. */
export function createTimelineItemSclipReference(_projectId: string, item: TimelineItem): string {
  return compact('item', item.id)
}

/** A pasteable target for a media-library asset before or after it is placed. */
export function createMediaSclipReference(_projectId: string, media: MediaMetadata): string {
  return compact('media', media.id)
}

/** A pasteable target for a transition bridge on the timeline. */
export function createTransitionSclipReference(_projectId: string, transitionId: string): string {
  return compact('transition', transitionId)
}

export async function copySclipReference(reference: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(reference)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = reference
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard access is unavailable')
}
