import type { TimelineItem } from '@/types/timeline'

/**
 * A revision for the part of a timeline that determines where transcript
 * words appear. It intentionally excludes visual-only changes: those do not
 * make a word reference unsafe, while a trim, split, move, speed change, or
 * source swap does.
 */
export interface ScriptTimelineSnapshot {
  fps: number
  items: readonly TimelineItem[]
}

function scriptPlacement(item: TimelineItem) {
  const media = item as TimelineItem & {
    mediaId?: string
    sourceStart?: number
    sourceEnd?: number
    sourceFps?: number
    speed?: number
    isReversed?: boolean
  }
  return {
    id: item.id,
    type: item.type,
    trackId: item.trackId,
    from: item.from,
    durationInFrames: item.durationInFrames,
    mediaId: media.mediaId ?? null,
    sourceStart: media.sourceStart ?? null,
    sourceEnd: media.sourceEnd ?? null,
    sourceFps: media.sourceFps ?? null,
    speed: media.speed ?? 1,
    isReversed: media.isReversed === true,
  }
}

function toStableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(toStableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${toStableJson(record[key])}`).join(',')}}`
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Produces a content address for script placements. A confirmed script edit
 * must carry this value from its preview; otherwise it must re-read the script
 * instead of possibly cutting a stale placement.
 */
export async function buildScriptTimelineRevision(snapshot: ScriptTimelineSnapshot): Promise<string> {
  const content = toStableJson({
    fps: snapshot.fps,
    items: snapshot.items
      .filter((item) => item.type === 'video' || item.type === 'audio')
      .map(scriptPlacement)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return `sha256:${hex(digest)}`
}
