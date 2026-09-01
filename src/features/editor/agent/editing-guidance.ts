/**
 * SCLIP Editorial Guidance (Phase 2A)
 *
 * Exposes concise, source-traceable craft principles, tunable heuristics, and
 * genre-aware guidance to Hermes so the agent can reason about WHAT edit to
 * make, WHY, and when NOT to cut.
 */

import {
  getEditingGuidance as getPerceptionEditorialGuidance,
  EDITORIAL_KNOWLEDGE_VERSION,
  type EditorialKnowledgeModule,
  type EditingGuidanceResponse,
  type GetEditingGuidanceOptions,
} from '@/perception'

export {
  EDITORIAL_KNOWLEDGE_VERSION,
  type EditorialKnowledgeModule,
  type EditingGuidanceResponse,
  type GetEditingGuidanceOptions,
}

export const EDITING_GUIDANCE_VERSION = EDITORIAL_KNOWLEDGE_VERSION

export function getEditingGuidance(options: GetEditingGuidanceOptions | unknown): EditingGuidanceResponse {
  // Support both legacy array format `getEditingGuidance(['hook', 'pacing'])`
  // and rich object format `getEditingGuidance({ topics: [...], contentTypes: [...] })`
  if (Array.isArray(options)) {
    return getPerceptionEditorialGuidance({ topics: options })
  }
  return getPerceptionEditorialGuidance(options)
}
