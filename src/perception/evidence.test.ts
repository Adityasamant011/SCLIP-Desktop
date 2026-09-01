import { describe, expect, it } from 'vitest'
import {
  buildAssetFingerprint,
  buildTimelineRevision,
  evidenceStalenessReason,
  isEvidenceCurrent,
  type SclipEvidenceItem,
} from './index.ts'

describe('SCLIP evidence provenance', () => {
  it('keeps source evidence valid when the timeline changes', () => {
    const fingerprint = buildAssetFingerprint({ mediaId: 'asset-a', contentHash: 'abcd' })
    const evidence: SclipEvidenceItem = {
      id: 'source-a', scope: 'source', kind: 'visual_caption', summary: 'A presenter at a desk.',
      confidence: 0.9, provider: 'local-vlm', createdAt: '2026-08-25T00:00:00.000Z',
      anchor: { assetId: 'asset-a', assetFingerprint: fingerprint, sourceRange: { startSec: 0, endSec: 2 } },
      limitations: [],
    }
    expect(isEvidenceCurrent(evidence, { assetFingerprints: { 'asset-a': fingerprint }, projectRevision: 'timeline:new' })).toBe(true)
  })

  it('invalidates composed evidence when any visible timeline state changes', () => {
    const original = buildTimelineRevision({ projectId: 'p', fps: 30, items: [{ id: 'a', from: 0 }], tracks: [], transitions: [], keyframes: [], markers: [] })
    const changed = buildTimelineRevision({ projectId: 'p', fps: 30, items: [{ id: 'a', from: 12 }], tracks: [], transitions: [], keyframes: [], markers: [] })
    const evidence: SclipEvidenceItem = {
      id: 'composed-a', scope: 'composed', kind: 'preview', summary: 'Title is visible.', confidence: 0.8,
      provider: 'local-vlm', createdAt: '2026-08-25T00:00:00.000Z',
      anchor: { projectId: 'p', projectRevision: original, sampledFrames: [0] }, limitations: [],
    }
    expect(original).not.toBe(changed)
    expect(isEvidenceCurrent(evidence, { projectRevision: changed })).toBe(false)
    expect(evidenceStalenessReason(evidence, { projectRevision: changed })).toContain('timeline changed')
  })

  it('uses a labelled metadata identity only when no content hash exists', () => {
    expect(buildAssetFingerprint({ mediaId: 'asset-a', fileSize: 4, fileLastModified: 5, mimeType: 'video/mp4' }))
      .toBe('media:asset-a:4:5:video/mp4')
  })
})
