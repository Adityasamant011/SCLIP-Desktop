/**
 * SCLIP Creator Style Learning & Preference Plumbing (Phase 6)
 *
 * Implements:
 * 1. Structured CorrectionEvent capture (ACCEPTED, REJECTED, MODIFIED, UNDONE, EXPLICIT).
 * 2. Semantic Timeline Diff calculation across dimensions (pacing, B-roll, punch-in, audio, music).
 * 3. Scope-aware CreatorStylePreference accumulation (GLOBAL, CONTENT_TYPE, PROJECT).
 * 4. Epistemic status & confidence accumulation (tentative -> established -> conflicted -> explicit).
 * 5. Selective, token-budgeted style context retrieval for Hermes (< 300 tokens).
 * 6. Profile persistence, inspection, deletion, and reset controls.
 */

export type StyleScope = 'GLOBAL' | 'CONTENT_TYPE' | 'PROJECT'

export type StyleDimension =
  | 'pacing.pause_duration'
  | 'pacing.sentence_spacing'
  | 'broll.frequency'
  | 'broll.duration'
  | 'framing.punch_in_magnitude'
  | 'framing.punch_in_frequency'
  | 'audio.breath_preservation'
  | 'audio.seam_smoothing'
  | 'music.ducking_depth'
  | 'music.beat_snapping'
  | 'transitions.frequency'
  | 'transitions.type'

export type CorrectionOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'UNDONE_AFTER_ACCEPT'
  | 'MANUAL_EDIT_RELATED_TO_AI_DECISION'
  | 'EXPLICIT_PREFERENCE_STATEMENT'

export type PreferenceStatus = 'tentative' | 'established' | 'explicit' | 'conflicted'

export type PreferenceOrigin =
  | 'explicit_user_instruction'
  | 'behavioral_correction'
  | 'acceptance'
  | 'rejection'
  | 'undo'

export interface SemanticEditDelta {
  dimension: StyleDimension
  proposedValue: number | string | boolean
  userValue: number | string | boolean
  deltaScore?: number
  description: string
}

export interface CorrectionEvent {
  id: string
  timestamp: number
  projectId: string
  scope?: StyleScope
  contentType?: 'talking_head' | 'interview' | 'montage' | 'short_form' | 'documentary' | 'general'
  decisionId?: string
  planId?: string
  operationId?: string
  outcome: CorrectionOutcome
  semanticDeltas: SemanticEditDelta[]
  evidenceIds: string[]
  explicitStatement?: string
}

export interface CreatorStylePreference {
  id: string
  dimension: StyleDimension
  scope: StyleScope
  scopeKey: string // 'global', 'talking_head', 'proj-123', etc.
  preference: {
    qualitative: 'tight' | 'moderate' | 'relaxed' | 'sparse' | 'dense' | 'subtle' | 'aggressive' | 'natural' | 'custom'
    targetValue?: number | string
    observedRange?: { min: number; max: number; avg: number }
    summary: string
  }
  confidence: number // 0.0 to 1.0
  origin: PreferenceOrigin
  evidenceEventIds: string[]
  supportingCount: number
  conflictingCount: number
  status: PreferenceStatus
  lastUpdated: number
}

export interface CreatorStyleProfile {
  version: 1
  creatorId: string
  preferences: CreatorStylePreference[]
  recentEvents: CorrectionEvent[]
  lastUpdated: number
}

export interface StyleRetrievalQuery {
  projectId: string
  contentType?: 'talking_head' | 'interview' | 'montage' | 'short_form' | 'documentary' | 'general'
  taskIntent?: string
  dimensions?: StyleDimension[]
  projectIntentOverride?: string
}

export interface RetrievedStyleContext {
  relevantPreferences: Array<{
    dimension: StyleDimension
    scope: StyleScope
    scopeKey: string
    qualitative: string
    summary: string
    confidence: number
    status: PreferenceStatus
    origin: PreferenceOrigin
  }>
  projectIntentOverride?: string
  concisePromptSummary: string
  tokenCountEstimate: number
}

/**
 * Initialize a blank CreatorStyleProfile.
 */
export function createBlankStyleProfile(creatorId = 'default_creator'): CreatorStyleProfile {
  return {
    version: 1,
    creatorId,
    preferences: [],
    recentEvents: [],
    lastUpdated: Date.now(),
  }
}

/**
 * Compute semantic diff between an AI proposed operation and a user's timeline modification.
 */
export function computeSemanticTimelineDiff(input: {
  dimension: StyleDimension
  proposedValue: number | string | boolean
  userValue: number | string | boolean
}): SemanticEditDelta {
  let deltaScore: number | undefined
  let description = `User changed ${input.dimension} from ${String(input.proposedValue)} to ${String(input.userValue)}`

  if (typeof input.proposedValue === 'number' && typeof input.userValue === 'number') {
    deltaScore = Number((input.userValue - input.proposedValue).toFixed(3))
    if (input.dimension === 'pacing.pause_duration') {
      description = deltaScore < 0
        ? `User shortened pause by ${Math.abs(deltaScore)}s (tighter pacing)`
        : `User lengthened pause by ${deltaScore}s (more relaxed pacing)`
    } else if (input.dimension === 'framing.punch_in_magnitude') {
      description = deltaScore < 0
        ? `User reduced punch-in scale by ${Math.abs(deltaScore)}x (more subtle framing)`
        : `User increased punch-in scale by ${deltaScore}x (more aggressive framing)`
    } else if (input.dimension === 'music.ducking_depth') {
      description = deltaScore > 0
        ? `User raised music level by ${deltaScore}dB (gentler ducking)`
        : `User deepened music ducking by ${Math.abs(deltaScore)}dB (stronger voice isolation)`
    }
  } else if (input.dimension === 'broll.frequency') {
    description = input.userValue === 'sparse' || input.userValue === false
      ? 'User deleted B-roll overlay, preferring A-roll delivery'
      : 'User retained or added B-roll overlay'
  }

  return {
    dimension: input.dimension,
    proposedValue: input.proposedValue,
    userValue: input.userValue,
    deltaScore,
    description,
  }
}

/**
 * Ingest a CorrectionEvent and update the CreatorStyleProfile with confidence accumulation.
 */
export function accumulateCreatorStyle(
  profile: CreatorStyleProfile,
  event: CorrectionEvent,
): CreatorStyleProfile {
  const updated = {
    ...profile,
    preferences: [...profile.preferences],
    recentEvents: [event, ...profile.recentEvents.slice(0, 99)],
    lastUpdated: Date.now(),
  }

  // Process explicit preference statement
  if (event.outcome === 'EXPLICIT_PREFERENCE_STATEMENT' && event.explicitStatement) {
    for (const delta of event.semanticDeltas) {
      const scope: StyleScope = event.scope ?? (event.contentType ? 'CONTENT_TYPE' : 'GLOBAL')
      const scopeKey = scope === 'PROJECT' ? event.projectId : (event.contentType ?? 'global')
      const prefId = `pref-explicit-${delta.dimension}-${scopeKey}`

      const existingIndex = updated.preferences.findIndex((p) => p.id === prefId)
      const explicitPref: CreatorStylePreference = {
        id: prefId,
        dimension: delta.dimension,
        scope,
        scopeKey,
        preference: {
          qualitative: String(delta.userValue) as any,
          targetValue: typeof delta.userValue === 'number' ? delta.userValue : undefined,
          summary: event.explicitStatement,
        },
        confidence: 0.95,
        origin: 'explicit_user_instruction',
        evidenceEventIds: [event.id],
        supportingCount: 1,
        conflictingCount: 0,
        status: 'explicit',
        lastUpdated: Date.now(),
      }

      if (existingIndex >= 0) {
        updated.preferences[existingIndex] = explicitPref
      } else {
        updated.preferences.push(explicitPref)
      }
    }
    return updated
  }

  // Process behavioral modifications, accepts, rejections
  for (const delta of event.semanticDeltas) {
    const scope: StyleScope = event.scope ?? (event.contentType ? 'CONTENT_TYPE' : 'GLOBAL')
    const scopeKey = scope === 'PROJECT' ? event.projectId : (event.contentType ?? 'global')
    const prefId = `pref-inferred-${delta.dimension}-${scopeKey}`

    const existingIndex = updated.preferences.findIndex((p) => p.id === prefId)
    const existing = updated.preferences[existingIndex]

    let qualitative: 'tight' | 'moderate' | 'relaxed' | 'sparse' | 'dense' | 'subtle' | 'aggressive' | 'natural' | 'custom' = 'moderate'

    if (delta.dimension === 'pacing.pause_duration') {
      if (typeof delta.userValue === 'number') {
        qualitative = delta.userValue <= 0.25 ? 'tight' : delta.userValue >= 0.60 ? 'relaxed' : 'moderate'
      }
    } else if (delta.dimension === 'framing.punch_in_magnitude') {
      if (typeof delta.userValue === 'number') {
        qualitative = delta.userValue <= 1.12 ? 'subtle' : 'aggressive'
      }
    } else if (delta.dimension === 'broll.frequency') {
      qualitative = (delta.userValue === 'sparse' || delta.userValue === false) ? 'sparse' : 'dense'
    } else if (delta.dimension === 'audio.breath_preservation') {
      qualitative = delta.userValue === true ? 'natural' : 'tight'
    }

    if (!existing) {
      // First observation -> Tentative preference (confidence: 0.35)
      const newPref: CreatorStylePreference = {
        id: prefId,
        dimension: delta.dimension,
        scope,
        scopeKey,
        preference: {
          qualitative,
          targetValue: typeof delta.userValue === 'number' ? delta.userValue : undefined,
          observedRange: typeof delta.userValue === 'number'
            ? { min: delta.userValue, max: delta.userValue, avg: delta.userValue }
            : undefined,
          summary: `Creator observed choosing ${qualitative} ${delta.dimension.replace('.', ' ')} in ${scopeKey}.`,
        },
        confidence: event.outcome === 'ACCEPTED' ? 0.25 : 0.35,
        origin: event.outcome === 'ACCEPTED' ? 'acceptance' : 'behavioral_correction',
        evidenceEventIds: [event.id],
        supportingCount: 1,
        conflictingCount: 0,
        status: 'tentative',
        lastUpdated: Date.now(),
      }
      updated.preferences.push(newPref)
    } else {
      // Existing preference -> Accumulate confidence or conflict
      const isConsistent = existing.preference.qualitative === qualitative

      if (isConsistent) {
        const newSupporting = existing.supportingCount + 1
        const newConfidence = Math.min(0.92, Number((existing.confidence + 0.15).toFixed(2)))
        const newStatus: PreferenceStatus = newSupporting >= 3 ? 'established' : 'tentative'

        let observedRange = existing.preference.observedRange
        if (typeof delta.userValue === 'number' && observedRange) {
          observedRange = {
            min: Math.min(observedRange.min, delta.userValue),
            max: Math.max(observedRange.max, delta.userValue),
            avg: Number(((observedRange.avg * existing.supportingCount + delta.userValue) / newSupporting).toFixed(3)),
          }
        }

        updated.preferences[existingIndex] = {
          ...existing,
          confidence: newConfidence,
          supportingCount: newSupporting,
          status: newStatus,
          evidenceEventIds: [...existing.evidenceEventIds, event.id].slice(-20),
          preference: {
            ...existing.preference,
            observedRange,
            summary: `Creator repeatedly chooses ${qualitative} ${delta.dimension.replace('.', ' ')} in ${scopeKey} (${newSupporting} observations).`,
          },
          lastUpdated: Date.now(),
        }
      } else {
        // Conflicting observation
        const newConflicting = existing.conflictingCount + 1
        const newConfidence = Math.max(0.15, Number((existing.confidence - 0.20).toFixed(2)))
        const isConflicted = newConflicting >= 2

        updated.preferences[existingIndex] = {
          ...existing,
          confidence: newConfidence,
          conflictingCount: newConflicting,
          status: isConflicted ? 'conflicted' : existing.status,
          evidenceEventIds: [...existing.evidenceEventIds, event.id].slice(-20),
          preference: {
            ...existing.preference,
            summary: isConflicted
              ? `Mixed preferences observed for ${delta.dimension.replace('.', ' ')} in ${scopeKey} (${existing.supportingCount} for ${existing.preference.qualitative}, ${newConflicting} for ${qualitative}).`
              : existing.preference.summary,
          },
          lastUpdated: Date.now(),
        }
      }
    }
  }

  return updated
}

/**
 * Retrieve selective, bounded style context for Hermes during a reasoning turn.
 */
export function getCreatorStyleContext(
  profile: CreatorStyleProfile,
  query: StyleRetrievalQuery,
): RetrievedStyleContext {
  const relevant: RetrievedStyleContext['relevantPreferences'] = []

  for (const pref of profile.preferences) {
    // 1. Filter by dimension if specified
    if (query.dimensions && query.dimensions.length > 0 && !query.dimensions.includes(pref.dimension)) {
      continue
    }

    // 2. Filter by scope & contentType
    if (pref.scope === 'CONTENT_TYPE') {
      if (!query.contentType || pref.scopeKey !== query.contentType) {
        continue // No cross-content contamination
      }
    } else if (pref.scope === 'PROJECT') {
      if (pref.scopeKey !== query.projectId) {
        continue // Project preference does not leak to other projects
      }
    }

    // Include preference
    relevant.push({
      dimension: pref.dimension,
      scope: pref.scope,
      scopeKey: pref.scopeKey,
      qualitative: pref.preference.qualitative,
      summary: pref.preference.summary,
      confidence: pref.confidence,
      status: pref.status,
      origin: pref.origin,
    })
  }

  // Format concise prompt summary for Hermes
  const lines: string[] = []
  if (query.projectIntentOverride) {
    lines.push(`PROJECT INTENT OVERRIDE: "${query.projectIntentOverride}" (Overrides default creator style).`)
  }

  if (relevant.length > 0) {
    lines.push('CREATOR STYLE PREFERENCES (Relevant to current context):')
    for (const r of relevant) {
      const statusLabel = r.status === 'explicit' ? '[EXPLICIT]' : r.status === 'established' ? '[ESTABLISHED]' : r.status === 'conflicted' ? '[CONFLICTED]' : '[TENTATIVE]'
      lines.push(`- ${statusLabel} ${r.dimension} in ${r.scopeKey}: ${r.summary} (confidence: ${r.confidence})`)
    }
  } else {
    lines.push('CREATOR STYLE: No specific preferences learned for this scope yet; apply standard professional editing principles.')
  }

  const concisePromptSummary = lines.join('\n')
  const tokenCountEstimate = Math.ceil(concisePromptSummary.length / 4)

  return {
    relevantPreferences: relevant,
    projectIntentOverride: query.projectIntentOverride,
    concisePromptSummary,
    tokenCountEstimate,
  }
}

/**
 * Delete a specific preference by ID.
 */
export function deleteCreatorPreference(
  profile: CreatorStyleProfile,
  preferenceId: string,
): CreatorStyleProfile {
  return {
    ...profile,
    preferences: profile.preferences.filter((p) => p.id !== preferenceId),
    lastUpdated: Date.now(),
  }
}

/**
 * Clear all inferred preferences while retaining explicit user instructions.
 */
export function clearInferredPreferences(profile: CreatorStyleProfile): CreatorStyleProfile {
  return {
    ...profile,
    preferences: profile.preferences.filter((p) => p.origin === 'explicit_user_instruction'),
    lastUpdated: Date.now(),
  }
}

/**
 * Clear project-scoped preferences for a specific project.
 */
export function clearProjectPreferences(
  profile: CreatorStyleProfile,
  projectId: string,
): CreatorStyleProfile {
  return {
    ...profile,
    preferences: profile.preferences.filter((p) => p.scope !== 'PROJECT' || p.scopeKey !== projectId),
    lastUpdated: Date.now(),
  }
}

/**
 * EXPERIMENTAL CONFIDENCE WEIGHTS:
 * Tunable default weights for accumulating confidence across user interactions.
 * These are calibrated defaults, not immutable universal laws.
 */
export const EXPERIMENTAL_CONFIDENCE_WEIGHTS = {
  INITIAL_TENTATIVE: 0.35,
  CONSISTENT_STEP: 0.15,
  ACCEPTANCE_STEP: 0.10,
  CONFLICT_PENALTY: 0.20,
  ESTABLISHED_THRESHOLD_COUNT: 3,
  CONFIDENCE_CAP: 0.92,
  EXPLICIT_CONFIDENCE: 0.95,
} as const

/**
 * Deterministically reconstruct a CreatorStyleProfile by replaying an archive of CorrectionEvents.
 */
export function reconstructStyleProfileFromEvents(
  events: CorrectionEvent[],
  creatorId = 'default_creator',
): CreatorStyleProfile {
  let profile = createBlankStyleProfile(creatorId)
  // Sort events chronologically
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  for (const event of sorted) {
    profile = accumulateCreatorStyle(profile, event)
  }
  return profile
}

/**
 * Automatically compare user's post-edit timeline state with an applied AI EditPlan
 * and generate a grounded CorrectionEvent with semantic deltas.
 */
export function detectTimelineModificationCorrection(input: {
  projectId: string
  planId: string
  operationId?: string
  contentType?: 'talking_head' | 'interview' | 'montage' | 'short_form' | 'documentary' | 'general'
  aiProposedState: {
    itemId: string
    pauseDurationSec?: number
    punchInScale?: number
    brollPlaced?: boolean
    duckingDb?: number
  }
  userModifiedState: {
    itemId: string
    pauseDurationSec?: number
    punchInScale?: number
    brollPlaced?: boolean
    duckingDb?: number
  }
}): CorrectionEvent | null {
  if (input.aiProposedState.itemId !== input.userModifiedState.itemId) {
    return null // Unrelated item edit
  }

  const semanticDeltas: SemanticEditDelta[] = []

  // Check pause modification
  if (
    typeof input.aiProposedState.pauseDurationSec === 'number' &&
    typeof input.userModifiedState.pauseDurationSec === 'number' &&
    Math.abs(input.aiProposedState.pauseDurationSec - input.userModifiedState.pauseDurationSec) > 0.03
  ) {
    semanticDeltas.push(
      computeSemanticTimelineDiff({
        dimension: 'pacing.pause_duration',
        proposedValue: input.aiProposedState.pauseDurationSec,
        userValue: input.userModifiedState.pauseDurationSec,
      }),
    )
  }

  // Check punch-in scale modification
  if (
    typeof input.aiProposedState.punchInScale === 'number' &&
    typeof input.userModifiedState.punchInScale === 'number' &&
    Math.abs(input.aiProposedState.punchInScale - input.userModifiedState.punchInScale) > 0.02
  ) {
    semanticDeltas.push(
      computeSemanticTimelineDiff({
        dimension: 'framing.punch_in_magnitude',
        proposedValue: input.aiProposedState.punchInScale,
        userValue: input.userModifiedState.punchInScale,
      }),
    )
  }

  // Check B-roll overlay deletion/modification
  if (
    input.aiProposedState.brollPlaced !== undefined &&
    input.userModifiedState.brollPlaced !== undefined &&
    input.aiProposedState.brollPlaced !== input.userModifiedState.brollPlaced
  ) {
    semanticDeltas.push(
      computeSemanticTimelineDiff({
        dimension: 'broll.frequency',
        proposedValue: input.aiProposedState.brollPlaced ? 'dense' : 'sparse',
        userValue: input.userModifiedState.brollPlaced ? 'dense' : 'sparse',
      }),
    )
  }

  // Check music ducking modification
  if (
    typeof input.aiProposedState.duckingDb === 'number' &&
    typeof input.userModifiedState.duckingDb === 'number' &&
    Math.abs(input.aiProposedState.duckingDb - input.userModifiedState.duckingDb) > 1.0
  ) {
    semanticDeltas.push(
      computeSemanticTimelineDiff({
        dimension: 'music.ducking_depth',
        proposedValue: input.aiProposedState.duckingDb,
        userValue: input.userModifiedState.duckingDb,
      }),
    )
  }

  if (semanticDeltas.length === 0) {
    return null // No semantic modification detected
  }

  return {
    id: `corr-${input.projectId}-${Date.now()}`,
    timestamp: Date.now(),
    projectId: input.projectId,
    planId: input.planId,
    operationId: input.operationId,
    contentType: input.contentType,
    outcome: 'MODIFIED',
    semanticDeltas,
    evidenceIds: [`plan:${input.planId}`],
  }
}

/**
 * Check if a manual timeline edit is related to an AI proposal based on item and time range overlap.
 */
export function isManualEditRelatedToAiPlan(input: {
  manualItemId: string
  manualRangeSec: { startSec: number; endSec: number }
  aiPlanAffectedItems: string[]
  aiPlanRangeSec?: { startSec: number; endSec: number }
}): boolean {
  if (input.aiPlanAffectedItems.includes(input.manualItemId)) {
    return true
  }
  if (input.aiPlanRangeSec) {
    const overlaps =
      input.manualRangeSec.startSec < input.aiPlanRangeSec.endSec &&
      input.manualRangeSec.endSec > input.aiPlanRangeSec.startSec
    return overlaps
  }
  return false
}

