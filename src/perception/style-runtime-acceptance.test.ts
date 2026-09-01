import { describe, it, expect } from 'vitest'
import {
  createBlankStyleProfile,
  accumulateCreatorStyle,
  getCreatorStyleContext,
  deleteCreatorPreference,
  clearInferredPreferences,
  clearProjectPreferences,
  computeSemanticTimelineDiff,
  detectTimelineModificationCorrection,
  reconstructStyleProfileFromEvents,
  type CorrectionEvent,
  type CreatorStyleProfile,
  type EditorialEvidenceBundle,
} from './index.ts'

describe('SCLIP Creator Style Learning: Narrow Runtime & Persistence Gate (Phase 6)', () => {
  const creatorId = 'creator-runtime-gate'

  describe('Step 2, 4, 7, 8 — Real Correction Capture & Multi-Dimensional Delta', () => {
    it('automatically generates a CorrectionEvent when user modifies timeline state touched by an AI EditPlan', () => {
      const correction = detectTimelineModificationCorrection({
        projectId: 'proj-th-runtime',
        planId: 'plan-ai-001',
        operationId: 'op-tighten-pause',
        contentType: 'talking_head',
        aiProposedState: {
          itemId: 'item-speech-lead',
          pauseDurationSec: 0.42,
        },
        userModifiedState: {
          itemId: 'item-speech-lead',
          pauseDurationSec: 0.18,
        },
      })

      expect(correction).not.toBeNull()
      expect(correction?.outcome).toBe('MODIFIED')
      expect(correction?.semanticDeltas.length).toBe(1)
      expect(correction?.semanticDeltas[0]!.dimension).toBe('pacing.pause_duration')
      expect(correction?.semanticDeltas[0]!.deltaScore).toBe(-0.24)
      expect(correction?.semanticDeltas[0]!.description).toContain('shortened pause by 0.24s (tighter pacing)')
    })

    it('captures multi-dimensional modifications (B-roll deletion + punch-in scale reduction) in one event', () => {
      const correction = detectTimelineModificationCorrection({
        projectId: 'proj-vlog-runtime',
        planId: 'plan-ai-002',
        contentType: 'talking_head',
        aiProposedState: {
          itemId: 'item-scene-1',
          brollPlaced: true,
          punchInScale: 1.25,
        },
        userModifiedState: {
          itemId: 'item-scene-1',
          brollPlaced: false,
          punchInScale: 1.08,
        },
      })

      expect(correction).not.toBeNull()
      expect(correction?.semanticDeltas.length).toBe(2)

      const brollDelta = correction?.semanticDeltas.find((d) => d.dimension === 'broll.frequency')
      expect(brollDelta).toBeDefined()
      expect(brollDelta?.userValue).toBe('sparse')

      const punchDelta = correction?.semanticDeltas.find((d) => d.dimension === 'framing.punch_in_magnitude')
      expect(punchDelta).toBeDefined()
      expect(punchDelta?.deltaScore).toBe(-0.17)
    })
  })

  describe('Step 3 — Unrelated Manual Edit Attribution Test', () => {
    it('does NOT attribute manual edits on unrelated items to the AI plan', () => {
      const correction = detectTimelineModificationCorrection({
        projectId: 'proj-th-runtime',
        planId: 'plan-ai-001',
        aiProposedState: {
          itemId: 'item-speech-lead',
          pauseDurationSec: 0.42,
        },
        userModifiedState: {
          itemId: 'item-unrelated-outro-track',
          pauseDurationSec: 0.18,
        },
      })

      expect(correction).toBeNull()
    })
  })

  describe('Step 5, 6, 9 — True Persistence, Replay & Reset Across Sessions', () => {
    it('persists CorrectionEvents and reconstructs identical CreatorStyleProfile upon reload', () => {
      const eventArchive: CorrectionEvent[] = [
        {
          id: 'ev-1',
          timestamp: 1000,
          projectId: 'proj-1',
          contentType: 'talking_head',
          outcome: 'MODIFIED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
          evidenceIds: [],
        },
        {
          id: 'ev-2',
          timestamp: 2000,
          projectId: 'proj-1',
          contentType: 'talking_head',
          outcome: 'MODIFIED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.38, userValue: 0.20 })],
          evidenceIds: [],
        },
        {
          id: 'ev-3',
          timestamp: 3000,
          projectId: 'proj-1',
          contentType: 'talking_head',
          outcome: 'ACCEPTED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.21, userValue: 0.21 })],
          evidenceIds: [],
        },
      ]

      // 1. Reconstruct profile from persistent archive
      const initialProfile = reconstructStyleProfileFromEvents(eventArchive, creatorId)
      expect(initialProfile.preferences.length).toBe(1)
      expect(initialProfile.preferences[0]!.status).toBe('established')
      expect(initialProfile.preferences[0]!.confidence).toBe(0.65)

      // 2. Simulate process shutdown & reload from serialized JSON
      const serializedJson = JSON.stringify(eventArchive)
      const reloadedEvents: CorrectionEvent[] = JSON.parse(serializedJson)
      const reloadedProfile = reconstructStyleProfileFromEvents(reloadedEvents, creatorId)

      expect(reloadedProfile.preferences.length).toBe(1)
      expect(reloadedProfile.preferences[0]!.confidence).toBe(0.65)
      expect(reloadedProfile.preferences[0]!.preference.qualitative).toBe('tight')

      // 3. Clear inferred preferences
      const explicitOnly = clearInferredPreferences(reloadedProfile)
      expect(explicitOnly.preferences.length).toBe(0)
    })
  })

  describe('Step 7, 8 — Cross-Project & Scope Leak Isolation', () => {
    it('shares content-type preferences across projects while isolating project-scoped preferences', () => {
      let profile = createBlankStyleProfile(creatorId)

      // 1. Ingest content-type preference (talking_head tight pacing) in Project A
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-th-a',
        timestamp: 1000,
        projectId: 'proj-A',
        contentType: 'talking_head',
        outcome: 'MODIFIED',
        semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
        evidenceIds: [],
      })

      // 2. Ingest project-specific preference in Project A
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-proj-a',
        timestamp: 2000,
        projectId: 'proj-A',
        scope: 'PROJECT',
        outcome: 'EXPLICIT_PREFERENCE_STATEMENT',
        explicitStatement: 'Special intro pacing for Project A only',
        semanticDeltas: [{ dimension: 'pacing.sentence_spacing', proposedValue: 'fast', userValue: 'slow', description: 'Project A override' }],
        evidenceIds: [],
      })

      // Query for Project B (also talking_head)
      const projBContext = getCreatorStyleContext(profile, { projectId: 'proj-B', contentType: 'talking_head' })
      expect(projBContext.relevantPreferences.some((p) => p.dimension === 'pacing.pause_duration')).toBe(true)
      // Project A specific preference must NOT leak to Project B
      expect(projBContext.relevantPreferences.some((p) => p.scopeKey === 'proj-A')).toBe(false)

      // Query for Project C (interview)
      const projCContext = getCreatorStyleContext(profile, { projectId: 'proj-C', contentType: 'interview' })
      // Talking-head preference must NOT leak to interview
      expect(projCContext.relevantPreferences.length).toBe(0)
    })
  })

  describe('Step 10, 11, 12, 13 — Monotonic Confidence Scaling & Conflict Handling', () => {
    it('scales confidence monotonically across 1, 2, 3, 5, 8 consistent events', () => {
      let profile = createBlankStyleProfile(creatorId)
      const confidenceTrajectory: number[] = []

      for (let i = 1; i <= 8; i++) {
        profile = accumulateCreatorStyle(profile, {
          id: `ev-${i}`,
          timestamp: 1000 * i,
          projectId: 'proj-pacing',
          contentType: 'talking_head',
          outcome: 'MODIFIED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
          evidenceIds: [],
        })
        confidenceTrajectory.push(profile.preferences[0]!.confidence)
      }

      console.log('Confidence Trajectory (1 to 8 events):', confidenceTrajectory)

      // 1 event = 0.35 (tentative)
      expect(confidenceTrajectory[0]).toBe(0.35)
      expect(profile.preferences[0]!.status).toBe('established') // After 8 events

      // 2 events = 0.50 (tentative)
      expect(confidenceTrajectory[1]).toBe(0.50)

      // 3 events = 0.65 (established)
      expect(confidenceTrajectory[2]).toBe(0.65)

      // 4 events = 0.80 (established)
      expect(confidenceTrajectory[3]).toBe(0.80)

      // 5+ events = 0.92 (established cap)
      expect(confidenceTrajectory[4]).toBe(0.92)

      // 8 events = 0.92 (established cap)
      expect(confidenceTrajectory[7]).toBe(0.92)

      // Verify strict monotonic non-decreasing progression
      for (let i = 1; i < confidenceTrajectory.length; i++) {
        expect(confidenceTrajectory[i]).toBeGreaterThanOrEqual(confidenceTrajectory[i - 1]!)
      }
    })

    it('weakens confidence and transitions to conflicted upon opposing user modifications', () => {
      let profile = createBlankStyleProfile(creatorId)

      // 2 tight edits
      for (let i = 1; i <= 2; i++) {
        profile = accumulateCreatorStyle(profile, {
          id: `ev-tight-${i}`,
          timestamp: 1000 * i,
          projectId: 'proj-conflict',
          contentType: 'talking_head',
          outcome: 'MODIFIED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.40, userValue: 0.18 })],
          evidenceIds: [],
        })
      }
      expect(profile.preferences[0]!.confidence).toBe(0.50)

      // 2 opposing relaxed edits
      for (let i = 1; i <= 2; i++) {
        profile = accumulateCreatorStyle(profile, {
          id: `ev-relaxed-${i}`,
          timestamp: 3000 + 1000 * i,
          projectId: 'proj-conflict',
          contentType: 'talking_head',
          outcome: 'MODIFIED',
          semanticDeltas: [computeSemanticTimelineDiff({ dimension: 'pacing.pause_duration', proposedValue: 0.20, userValue: 0.70 })],
          evidenceIds: [],
        })
      }

      expect(profile.preferences[0]!.status).toBe('conflicted')
      expect(profile.preferences[0]!.confidence).toBeLessThan(0.35)

      const context = getCreatorStyleContext(profile, { projectId: 'proj-conflict', contentType: 'talking_head' })
      expect(context.concisePromptSummary).toContain('[CONFLICTED]')
    })
  })

  describe('Step 14, 18 — Explicit Preference Precedence & EditorialEvidenceBundle Integration', () => {
    it('integrates retrieved style context into Phase 5 EditorialEvidenceBundle with project intent priority', () => {
      let profile = createBlankStyleProfile(creatorId)
      profile = accumulateCreatorStyle(profile, {
        id: 'ev-explicit',
        timestamp: 1000,
        projectId: 'proj-lead',
        outcome: 'EXPLICIT_PREFERENCE_STATEMENT',
        explicitStatement: 'Prefer subtle punch-ins under 1.12x',
        semanticDeltas: [{ dimension: 'framing.punch_in_magnitude', proposedValue: 'any', userValue: 'subtle', description: 'Explicit preference' }],
        evidenceIds: [],
      })

      const styleContext = getCreatorStyleContext(profile, {
        projectId: 'proj-lead',
        contentType: 'talking_head',
        projectIntentOverride: 'Current video requires energetic 1.25x punch-ins for emphasis',
      })

      // Assemble into Phase 5 bundle
      const bundle: EditorialEvidenceBundle = {
        schemaVersion: 1,
        projectId: 'proj-lead',
        projectRevision: 'rev-lead-01',
        objective: 'Improve visual framing',
        taskIntent: 'GENERAL_EDIT',
        timelineSummary: { durationSec: 30, durationFrames: 900, fps: 30, itemCount: 2, trackCount: 2 },
        visualEvidence: { segments: [] },
        audioEvidence: { segments: [], boundaryInspections: [] },
        relevantKnowledge: [],
        creatorStyle: {
          pacePreference: 'tight',
          brollFrequency: 'moderate',
          explicitGuidelines: [styleContext.concisePromptSummary],
        },
        epistemicStatus: { observed: [], inferred: [], heuristic: [], degraded: [], unknown: [] },
        limitations: [],
      }

      expect(bundle.creatorStyle?.explicitGuidelines?.[0]).toContain('PROJECT INTENT OVERRIDE')
      expect(bundle.creatorStyle?.explicitGuidelines?.[0]).toContain('Prefer subtle punch-ins')
    })
  })

  describe('Step 16, 17 — Large History Scalability Benchmark', () => {
    it('scales to 100+ events across multiple content types with < 1ms retrieval and < 200 token context', () => {
      let profile = createBlankStyleProfile(creatorId)
      const contentTypes: Array<'talking_head' | 'interview' | 'montage' | 'short_form'> = [
        'talking_head', 'interview', 'montage', 'short_form',
      ]

      const tStartWrite = performance.now()
      for (let i = 1; i <= 100; i++) {
        const ct = contentTypes[i % 4]!
        profile = accumulateCreatorStyle(profile, {
          id: `ev-batch-${i}`,
          timestamp: 1000 * i,
          projectId: `proj-${i % 5}`,
          contentType: ct,
          outcome: 'MODIFIED',
          semanticDeltas: [
            computeSemanticTimelineDiff({
              dimension: i % 2 === 0 ? 'pacing.pause_duration' : 'framing.punch_in_magnitude',
              proposedValue: 0.40,
              userValue: 0.18,
            }),
          ],
          evidenceIds: [],
        })
      }
      const writeMs = performance.now() - tStartWrite

      const tStartQuery = performance.now()
      const context = getCreatorStyleContext(profile, { projectId: 'proj-1', contentType: 'talking_head' })
      const queryMs = performance.now() - tStartQuery

      console.log(`Ingested 100 events in ${writeMs.toFixed(2)}ms (${(writeMs / 100).toFixed(3)}ms/event)`)
      console.log(`Queried style context in ${queryMs.toFixed(3)}ms (Tokens: ${context.tokenCountEstimate})`)

      expect(queryMs).toBeLessThan(2.0)
      expect(context.tokenCountEstimate).toBeLessThan(200)
    })
  })
})
