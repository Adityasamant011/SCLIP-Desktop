/**
 * The common provenance contract for SCLIP's perception and editorial
 * intelligence layers.
 *
 * Source evidence describes an immutable asset/range and survives timeline
 * edits. Timeline and composed evidence describe a particular project
 * revision and become stale as soon as the edit changes. Keeping those two
 * facts separate prevents an agent from treating an old preview observation
 * as proof of the current edit.
 */

export type EvidenceScope = 'source' | 'timeline' | 'composed'

export interface SourceEvidenceAnchor {
  assetId: string
  /** Content hash when available; otherwise a deterministic media identity. */
  assetFingerprint: string
  sourceRange?: { startSec: number; endSec: number }
}

export interface TimelineEvidenceAnchor {
  projectId: string
  /** Deterministic representation of the visible timeline state. */
  projectRevision: string
  timelineRange?: { startFrame: number; endFrame: number }
}

export interface ComposedEvidenceAnchor extends TimelineEvidenceAnchor {
  sampledFrames: number[]
}

export type EvidenceAnchor = SourceEvidenceAnchor | TimelineEvidenceAnchor | ComposedEvidenceAnchor

export interface SclipEvidenceItem {
  id: string
  scope: EvidenceScope
  kind: string
  summary: string
  confidence: number
  provider: string
  createdAt: string
  anchor: EvidenceAnchor
  limitations: string[]
}

export interface AssetFingerprintInput {
  mediaId: string
  contentHash?: string
  fileSize?: number
  fileLastModified?: number
  mimeType?: string
}

/**
 * This is an identity marker, not a security claim. A SHA-256 content hash is
 * preferred when FreeCut has one. The metadata fallback is deliberately
 * labelled `media:` so consumers cannot mistake it for a byte-level hash.
 */
export function buildAssetFingerprint(input: AssetFingerprintInput): string {
  if (input.contentHash?.trim()) return `sha256:${input.contentHash.trim().replace(/^sha256:/i, '')}`
  return [
    'media',
    input.mediaId,
    Number.isFinite(input.fileSize) ? input.fileSize : 'unknown-size',
    Number.isFinite(input.fileLastModified) ? input.fileLastModified : 'unknown-mtime',
    input.mimeType || 'unknown-mime',
  ].join(':')
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

/** A small deterministic digest suitable for invalidation, not cryptography. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface TimelineRevisionInput {
  projectId: string
  fps: number
  items: unknown[]
  tracks: unknown[]
  transitions: unknown[]
  keyframes: unknown[]
  markers: unknown[]
  inPoint?: number | null
  outPoint?: number | null
}

/**
 * Builds a revision from the state the audience can see. It is intentionally
 * separate from save timestamps: unsaved human edits must invalidate composed
 * evidence too.
 */
export function buildTimelineRevision(input: TimelineRevisionInput): string {
  const snapshot = stable({
    projectId: input.projectId,
    fps: input.fps,
    items: input.items,
    tracks: input.tracks,
    transitions: input.transitions,
    keyframes: input.keyframes,
    markers: input.markers,
    inPoint: input.inPoint ?? null,
    outPoint: input.outPoint ?? null,
  })
  return `timeline-fnv1a:${fnv1a(snapshot)}:${snapshot.length}`
}

export function isEvidenceCurrent(
  item: SclipEvidenceItem,
  current: { assetFingerprints?: Record<string, string>; projectRevision?: string },
): boolean {
  if (item.scope === 'source') {
    const anchor = item.anchor as SourceEvidenceAnchor
    return current.assetFingerprints?.[anchor.assetId] === anchor.assetFingerprint
  }
  const anchor = item.anchor as TimelineEvidenceAnchor
  return !!current.projectRevision && anchor.projectRevision === current.projectRevision
}

export function evidenceStalenessReason(
  item: SclipEvidenceItem,
  current: { assetFingerprints?: Record<string, string>; projectRevision?: string },
): string | null {
  if (isEvidenceCurrent(item, current)) return null
  if (item.scope === 'source') return 'The original media identity changed or is no longer available.'
  return 'The visible timeline changed after this evidence was created.'
}
