import type { SemanticMediaMap } from '@/perception'
import { deleteAiOutput, readAiOutput, writeAiOutput } from './ai-outputs'

/** Persisted, source-media semantic evidence. It is disposable and regenerated when its analyzer changes. */
export async function getSemanticMediaMap(mediaId: string): Promise<SemanticMediaMap | undefined> {
  const output = await readAiOutput(mediaId, 'semantic-map')
  // Maps are derived evidence, never project truth. Ignore legacy payloads
  // rather than allowing an old analyzer's assumptions into a fresh proposal.
  return output?.data?.schemaVersion === 3 ? output.data : undefined
}

export async function saveSemanticMediaMap(map: SemanticMediaMap): Promise<SemanticMediaMap> {
  const output = await writeAiOutput({
    mediaId: map.mediaId,
    kind: 'semantic-map',
    service: 'sclip-grounded-semantic-map',
    model: map.analyzerVersion,
    params: {
      transcriptSegments: map.grounding.transcript.segmentCount,
      visualMoments: map.grounding.visual.momentCount,
      schemaVersion: map.schemaVersion,
    },
    data: map,
  })
  return output.data
}

/** Source replacement invalidates this derived map; it must be regenerated for the new bytes. */
export async function deleteSemanticMediaMap(mediaId: string): Promise<void> {
  await deleteAiOutput(mediaId, 'semantic-map')
}
