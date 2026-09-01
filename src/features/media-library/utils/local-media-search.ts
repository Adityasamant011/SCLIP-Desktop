/**
 * Fast, local, evidence-preserving media search for agent workflows.
 *
 * It intentionally does not pretend that a filename match is semantic vision.
 * Results identify the exact caption/tag/filename evidence that matched, so
 * Hermes can propose B-roll without inventing what an asset contains.
 */
export interface LocalMediaSearchable {
  id: string
  fileName: string
  mimeType: string
  tags?: string[]
  aiCaptions?: Array<{
    timeSec: number
    text: string
    sceneData?: {
      caption?: string
      subjects?: string[]
      action?: string
      setting?: string
    }
    thumbRelPath?: string
  }>
}

export interface LocalMediaSearchResult {
  mediaId: string
  score: number
  matchedTerms: string[]
  evidence: Array<{ source: 'filename' | 'tag' | 'visual_caption'; text: string; timeSec?: number; thumbnailPath?: string }>
}

function normalise(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function searchLocalMedia(
  media: readonly LocalMediaSearchable[],
  query: string,
  maxResults = 20,
): LocalMediaSearchResult[] {
  const terms = Array.from(new Set(normalise(query).split(' ').filter((term) => term.length > 1)))
  if (!terms.length) return []

  return media.flatMap((asset) => {
    let score = 0
    const matchedTerms = new Set<string>()
    const evidence: LocalMediaSearchResult['evidence'] = []
    const fileName = normalise(asset.fileName)
    const fileMatches = terms.filter((term) => fileName.includes(term))
    if (fileMatches.length) {
      fileMatches.forEach((term) => matchedTerms.add(term))
      score += fileMatches.length * 3
      evidence.push({ source: 'filename', text: asset.fileName })
    }

    for (const tag of asset.tags ?? []) {
      const normalizedTag = normalise(tag)
      const tagMatches = terms.filter((term) => normalizedTag.includes(term))
      if (!tagMatches.length) continue
      tagMatches.forEach((term) => matchedTerms.add(term))
      score += tagMatches.length * 5
      evidence.push({ source: 'tag', text: tag })
    }

    for (const caption of asset.aiCaptions ?? []) {
      const scene = caption.sceneData
      const captionText = normalise([
        caption.text,
        scene?.caption,
        ...(scene?.subjects ?? []),
        scene?.action,
        scene?.setting,
      ].filter(Boolean).join(' '))
      const captionMatches = terms.filter((term) => captionText.includes(term))
      if (!captionMatches.length) continue
      captionMatches.forEach((term) => matchedTerms.add(term))
      score += captionMatches.length * 8
      evidence.push({
        source: 'visual_caption',
        text: caption.text,
        timeSec: caption.timeSec,
        ...(caption.thumbRelPath ? { thumbnailPath: caption.thumbRelPath } : {}),
      })
    }

    if (!score) return []
    return [{
      mediaId: asset.id,
      score,
      matchedTerms: Array.from(matchedTerms),
      evidence: evidence.slice(0, 6),
    }]
  }).sort((left, right) => right.score - left.score || left.mediaId.localeCompare(right.mediaId)).slice(0, Math.max(1, Math.min(50, maxResults)))
}
