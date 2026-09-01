import { describe, it, expect } from 'vitest'
import {
  createBlankStyleProfile,
  computeSemanticTimelineDiff,
  accumulateCreatorStyle,
  getCreatorStyleContext,
  deleteCreatorPreference,
  clearInferredPreferences,
  clearProjectPreferences,
  isManualEditRelatedToAiPlan,
  type CorrectionEvent,
  type CreatorStyleProfile,
} from './index.ts'

describe('SCLIP Creator Style Learning & Preference Plumbing (Phase 6)', () => {
  const creatorId = 'creator-test-alice'

  describe('Step 2, 4 — CorrectionEvent Schema & Semantic Diff Model', () => {
    it('computes semantic edit deltas for pause duration, punch-ins, B-roll, and music ducking', () => {
      // 1. Pause reduction
      const pauseDiff = computeSemanticTimelineDiff({
        dimension: 'pacing.pause_duration',
        proposedValue: 0.45,
        userValue: 0.18,
      })
      expect(pauseDiff.deltaScore).toBe(-0.27)
      expect(pauseDiff.description).toContain('shortened pause by 0.27s (tighter pacing)')

      // 2. Punch-in scale reduction
      const punchDiff = computeSemanticTimelineDiff({
        dimension: 'framing.punch_in_magnitude',
        proposedValue: 1.25,
        userValue: 1.10,
      })
      expect(punchDiff.deltaScore).toBe(-0.15)
      expect(punchDiff.description).toContain('reduced punch-in scale by 0.15x (more subtle framing)')

      // 3. Music ducking level increase
      const musicDiff = computeSemanticTimelineDiff({
        dimension: 'music.ducking_depth',
        proposedValue: -15.0,
        userValue: -9.0,
      })
      expect(musicDiff.deltaScore).toBe(6.0)
      expect(musicDiff.description).toContain('raised music level by 6dB (gentler ducking)')

      // 4. B-roll deletion
      const brollDiff = computeSemanticTimelineDiff({
        dimension: 'broll.frequency',
        proposedValue: 'dense',
        userValue: 'sparse',
      })
      expect(brollDiff.description).toContain('deleted B-roll overlay, preferring A-roll delivery')
    })
  })

  describe('Step 8, 17, 33 — Pause Learning & Confidence Accumulation', () => {
    it('treats single correction as tentative, then accumulates confidence across repeated consistent edits', () => {
      let profile = createBlankStyleProfile(creatorId)

      // Event 1: User shortens pause from 0.40s to 0.18s
      const event1: CorrectionEvent = {
        id: 'event-1',
        timestamp: Date.now(),
        projectId: 'proj-th-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [
          computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 }),
        ],
        evidenceIds: ['ev-speech-1'],
      }
      profile = accumulateCreatorStyle(profile, event1)

      expect(profile.preferences.length).toBe(1)
      const pref1 = profile.preferences[0]!
      expect(pref1.status).toBe('tentative')
      expect(pref1.confidence).toBe(0.35)
      expect(pref1.preference.qualitative).toBe('tight')
      expect(pref1.supportingCount).toBe(1)

      // Event 2: User shortens pause from 0.38s to 0.20s
      const event2: CorrectionEvent = {
        id: 'event-2',
        timestamp: Date.now(),
        projectId: 'proj-th-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [
          computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.38, userValue: 0.20 }),
        ],
        evidenceIds: ['ev-speech-2'],
      }
      profile = accumulateCreatorStyle(profile, event2)

      const pref2 = profile.preferences[0]!
      expect(pref2.confidence).toBe(0.50)
      expect(pref2.supportingCount).toBe(2)

      // Event 3: User accepts tighter pause proposal (0.21s)
      const event3: CorrectionEvent = {
        id: 'event-3',
        timestamp: Date.now(),
        projectId: 'proj-th-1',
        contentType: 'talking_head',
        outcome: 'ACCEPTED',
        semanticDeltas: [
          computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.21, userValue: 0.21 }),
        ],
        evidenceIds: ['ev-speech-3'],
      }
      profile = accumulateCreatorStyle(profile, event3)

      const pref3 = profile.preferences[0]!
      expect(pref3.status).toBe('established')
      expect(pref3.confidence).toBe(0.65)
      expect(pref3.supportingCount).toBe(3)
      expect(pref3.preference.observedRange?.min).toBe(0.18)
      expect(pref3.preference.observedRange?.max).toBe(0.21)
    })
  })

  describe('Step 18, 19, 20, 21 — Multi-Dimensional Style Learning (B-Roll, Punch-In, Audio, Music)', () => {
    it('infers subtle punch-in and natural breath preservation preferences', () => {
      let profile = createBlankStyleProfile(creatorId)

      // Punch-in reduction
      const punchEvent: CorrectionEvent = {
        id: 'event-punch',
        timestamp: Date.now(),
        projectId: 'proj-vlog',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [
          computeSemanticTimelineDiff({ dimension: 'framing.punch_in_magnitude', proposedValue: 1.25, userValue: 1.08 }),
        ],
        evidenceIds: ['ev-crop-1'],
      }
      profile = accumulateCreatorStyle(profile, punchEvent)

      // Breath preservation restoration
      const breathEvent: CorrectionEvent = {
        id: 'event-breath',
        timestamp: Date.now(),
        projectId: 'proj-vlog',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [
          computeSemanticTimelineDiff({ dimension: 'audio.breath_preservation', proposedValue: false, userValue: true }),
        ],
        evidenceIds: ['ev-breath-1'],
      }
      profile = accumulateCreatorStyle(profile, breathEvent)

      expect(profile.preferences.length).toBe(2)

      const punchPref = profile.preferences.find((p) => p.dimension === 'framing.punch_in_magnitude')
      expect(punchPref?.preference.qualitative).toBe('subtle')

      const breathPref = profile.preferences.find((p) => p.dimension === 'audio.breath_preservation')
      expect(breathPref?.preference.qualitative).toBe('natural')
    })
  })

  describe('Step 7, 15 — Explicit User Preference Input', () => {
    it('immediately assigns high confidence (0.95) and explicit status to direct user instructions', () => {
      let profile = createBlankStyleProfile(creatorId)

      const explicitEvent: CorrectionEvent = {
        id: 'event-explicit-1',
        timestamp: Date.now(),
        projectId: 'proj-any',
        outcome: 'EXPLICIT_PREFERENCE_STATEMENT',
        explicitStatement: 'Never use aggressive zoom punch-ins; keep camera framing subtle.',
        semanticDeltas: [
          {
            dimension: 'framing.punch_in_magnitude',
            proposedValue: 'any',
            userValue: 'subtle',
            description: 'Direct user instruction for subtle framing',
          },
        ],
        evidenceIds: [],
      }

      profile = accumulateCreatorStyle(profile, explicitEvent)

      expect(profile.preferences.length).toBe(1)
      const pref = profile.preferences[0]!
      expect(pref.status).toBe('explicit')
      expect(pref.origin).toBe('explicit_user_instruction')
      expect(pref.confidence).toBe(0.95)
      expect(pref.preference.summary).toContain('Never use aggressive zoom punch-ins')
    })
  })

  describe('Step 6, 9, 39 — Scope Isolation & Cross-Content Scoping', () => {
    it('isolates talking_head preferences from interview preferences without cross-contamination', () => {
      let profile = createBlankStyleProfile(creatorId)

      // Talking head tight pacing (2 observations)
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-th-1',
        timestamp: Date.now(),
        projectId: 'proj-th',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })

      // Interview relaxed pacing
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-int-1',
        timestamp: Date.now(),
        projectId: 'proj-int',
        contentType: 'interview',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.20, userValue: 0.75 })],
        evidenceIds: [],
      })

      expect(profile.preferences.length).toBe(2)

      // Query for talking_head context
      const thContext = getCreatorStyleContext(profile, { projectId: 'proj-new-th', contentType: 'talking_head' })
      expect(thContext.relevantPreferences.length).toBe(1)
      expect(thContext.relevantPreferences[0]!.scopeKey).toBe('talking_head')
      expect(thContext.relevantPreferences[0]!.qualitative).toBe('tight')

      // Query for interview context
      const intContext = getCreatorStyleContext(profile, { projectId: 'proj-new-int', contentType: 'interview' })
      expect(intContext.relevantPreferences.length).toBe(1)
      expect(intContext.relevantPreferences[0]!.scopeKey).toBe('interview')
      expect(intContext.relevantPreferences[0]!.qualitative).toBe('relaxed')
    })
  })

  describe('Step 13, 40 — Project Intent Override', () => {
    it('includes project intent override at top of Hermes style context summary', () => {
      let profile = createBlankStyleProfile(creatorId)
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-1',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })

      const context = getCreatorStyleContext(profile, {
        projectId: 'proj-cinematic-doc',
        contentType: 'talking_head',
        projectIntentOverride: 'Keep this video slow and contemplative for cinematic effect',
      })

      expect(context.projectIntentOverride).toBeDefined()
      expect(context.concisePromptSummary).toContain('PROJECT INTENT OVERRIDE: "Keep this video slow and contemplative')
      expect(context.concisePromptSummary).toContain('Overrides default creator style')
    })
  })

  describe('Step 24, 38 — Conflicting Evidence Resolution', () => {
    it('lowers confidence and sets status to conflicted when opposing edits occur in the same scope', () => {
      let profile = createBlankStyleProfile(creatorId)

      // 1. Initial tight pacing edit
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-1',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })
      expect(profile.preferences[0]!.confidence).toBe(0.35)

      // 2. Conflicting relaxed pacing edit in same scope
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-2',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.20, userValue: 0.70 })],
        evidenceIds: [],
      })

      expect(profile.preferences[0]!.conflictingCount).toBe(1)
      expect(profile.preferences[0]!.confidence).toBeLessThan(0.35)

      // 3. Second conflicting relaxed pacing edit
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-3',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.20, userValue: 0.75 })],
        evidenceIds: [],
      })

      expect(profile.preferences[0]!.conflictingCount).toBe(2)
      expect(profile.preferences[0]!.status).toBe('conflicted')
    })
  })

  describe('Step 28, 36, 37 — Persistence, Deletion & Reset Controls', () => {
    it('survives serialization/reload and supports preference deletion and resetting', () => {
      let profile = createBlankStyleProfile(creatorId)
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-1',
        timestamp: Date.now(),
        projectId: 'proj-1',
        outcome: 'EXPLICIT_PREFERENCE_STATEMENT',
        explicitStatement: 'Minimal transitions only',
        semanticDeltas: [{ dimension: 'transitions.frequency', proposedValue: 'dense', userValue: 'sparse', description: 'Explicit preference' }],
        evidenceIds: [],
      })
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-2',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })

      // 1. Serialization / Deserialization persistence
      const serialized = JSON.stringify(profile)
      const reloadedProfile: CreatorStyleProfile = JSON.parse(serialized)
      expect(reloadedProfile.preferences.length).toBe(2)

      // 2. Clear inferred preferences (preserves explicit)
      const explicitOnly = clearInferredPreferences(reloadedProfile)
      expect(explicitOnly.preferences.length).toBe(1)
      expect(explicitOnly.preferences[0]!.origin).toBe('explicit_user_instruction')

      // 3. Delete specific preference
      const empty = deleteCreatorPreference(explicitOnly, explicitOnly.preferences[0]!.id)
      expect(empty.preferences.length).toBe(0)
    })
  })

  describe('Step 31 — Unrelated Manual Edit Association Filter', () => {
    it('rejects manual edits on unrelated items or distant time ranges from AI plan attribution', () => {
      const isRelated = isManualEditRelatedToAiPlan({
        manualItemId: 'item-unrelated-track-4',
        manualRangeSec: { startSec: 120.0, endSec: 125.0 },
        aiPlanAffectedItems: ['item-speech-1', 'item-broll-2'],
        aiPlanRangeSec: { startSec: 10.0, endSec: 15.0 },
      })

      expect(isRelated).toBe(false)

      const isRelatedTrue = isManualEditRelatedToAiPlan({
        manualItemId: 'item-speech-1',
        manualRangeSec: { startSec: 12.0, endSec: 13.0 },
        aiPlanAffectedItems: ['item-speech-1'],
        aiPlanRangeSec: { startSec: 10.0, endSec: 15.0 },
      })

      expect(isRelatedTrue).toBe(true)
    })
  })

  describe('Step 41, 42 — Token Payload Budget & Retrieval Performance', () => {
    it('produces compact Hermes style context under 300 tokens even with multiple preferences', () => {
      let profile = createBlankStyleProfile(creatorId)

      // Add 4 distinct style preferences
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-1',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-2',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'framing.punch_in_magnitude', proposedValue: 1.25, userValue: 1.08 })],
        evidenceIds: [],
      })
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-3',
        timestamp: Date.now(),
        projectId: 'proj-1',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'broll.frequency', proposedValue: 'dense', userValue: 'sparse' })],
        evidenceIds: [],
      })

      const tStart = performance.now()
      const context = getCreatorStyleContext(profile, { projectId: 'proj-1', contentType: 'talking_head' })
      const durationMs = performance.now() - tStart

      console.log(`Style Retrieval Prompt Summary (${context.tokenCountEstimate} tokens):\n${context.concisePromptSummary}`)
      console.log(`Style Retrieval Duration: ${durationMs.toFixed(3)}ms`)

      expect(context.tokenCountEstimate).toBeLessThan(300)
      expect(durationMs).toBeLessThan(5.0)
    })
  })
})
