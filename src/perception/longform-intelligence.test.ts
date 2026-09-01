import { describe, it, expect } from 'vitest'
import {
  buildLongFormProjectMap,
  findCrossChapterRepetitions,
  initializeLongFormWorkingPlan,
  recordStageDecisions,
  validateStageRevisionLock,
  resolveSemanticAnchor,
  type LongFormEditObjective,
  type LongFormChapter,
  type EditorialDecision,
} from './index.ts'

describe('SCLIP Long-Form Editorial Autonomy & End-to-End Integration (Phase 7)', () => {
  const projectId = 'proj-longform-45m'
  const projectRevision = 'rev-lf-001'
  const totalDurationSec = 2700 // 45 minutes

  // Construct representative 45-minute timeline items across 9 chapters (~300s each)
  const items: Array<{ id: string; startSec: number; endSec: number; text?: string }> = []
  for (let c = 0; c < 9; c++) {
    const chapStart = c * 300
    for (let i = 0; i < 20; i++) {
      const itemStart = chapStart + i * 15
      let text = `Explanation of topic section ${c + 1} part ${i + 1}.`
      if (c === 1 && i === 10) {
        text = 'Here we explain the pricing model and subscription discounts for the SaaS tier.' // 07:30
      } else if (c === 5 && i === 16) {
        text = 'As mentioned earlier, our pricing model and subscription discounts offer 20% off.' // 29:00
      }
      items.push({
        id: `item-c${c + 1}-i${i + 1}`,
        startSec: itemStart,
        endSec: itemStart + 14.5,
        text,
      })
    }
  }

  describe('Step 2, 3, 4, 29 — 45-Minute Hierarchical Project Map & Bounded Summary', () => {
    it('segments 45-minute project into 9 bounded chapters with compact payload size', () => {
      const tStart = performance.now()
      const projectMap = buildLongFormProjectMap({
        projectId,
        projectRevision,
        totalDurationSec,
        items,
        approxChapterDurationSec: 300,
      })
      const durationMs = performance.now() - tStart

      expect(projectMap.chapters.length).toBe(9)
      expect(projectMap.totalDurationSec).toBe(2700)
      expect(projectMap.totalItems).toBe(180)

      // First chapter is Intro
      expect(projectMap.chapters[0]!.title).toContain('Introduction')
      expect(projectMap.chapters[0]!.importance).toBe('core')

      // Last chapter is Outro
      expect(projectMap.chapters[8]!.title).toContain('Conclusion')

      const payloadBytes = JSON.stringify(projectMap).length
      console.log(`45-Min Project Map Payload: ${payloadBytes} bytes (~${Math.round(payloadBytes / 4)} tokens)`)
      console.log(`Project Map Construction Duration: ${durationMs.toFixed(3)}ms`)

      // Must be bounded (< 6,000 bytes / ~1,500 tokens for 45 minutes)
      expect(payloadBytes).toBeLessThan(6000)
      expect(durationMs).toBeLessThan(10.0)
    })
  })

  describe('Step 7, 23, 30 — Cross-Window Repetition Search', () => {
    it('surfaces candidate semantic repetition between distant chapters (07:30 and 29:00) without auto-deletion', () => {
      const projectMap = buildLongFormProjectMap({ projectId, projectRevision, totalDurationSec, items })
      const repetitions = findCrossChapterRepetitions(
        projectMap,
        [{ concept: 'Pricing Model Explanation', keywords: ['pricing model', 'subscription discounts'] }],
        items,
      )

      expect(repetitions.length).toBe(1)
      const rep = repetitions[0]!
      expect(rep.concept).toBe('Pricing Model Explanation')
      expect(rep.chapterIds).toEqual(['chap-proj-longform-45m-2', 'chap-proj-longform-45m-6'])
      expect(rep.instances.length).toBe(2)
      expect(rep.instances[0]!.startSec).toBe(300) // Chapter 2
      expect(rep.instances[1]!.startSec).toBe(1500) // Chapter 6
      expect(rep.recommendation).toBe('REVIEW_REDUNDANCY')
    })
  })

  describe('Step 9, 10, 21, 22, 31 — Target Duration & Edit Budget Accounting', () => {
    it('initializes working plan and tracks estimated duration reductions across staged chapters', () => {
      const projectMap = buildLongFormProjectMap({ projectId, projectRevision, totalDurationSec, items })
      const objective: LongFormEditObjective = {
        targetDurationSec: 1920, // Target: 32 minutes (from 45m)
        contentType: 'tutorial',
        pacingIntent: 'tight',
        autonomyLevel: 'MEDIUM',
      }

      let plan = initializeLongFormWorkingPlan({ projectMap, objective })
      expect(plan.targetDurationSec).toBe(1920)
      expect(plan.currentEstimatedDurationSec).toBe(2700)
      expect(plan.pendingChapterIds.length).toBe(9)

      // Stage 1: Review Chapter 1, propose removing 120s of false starts / dead hesitation
      const stage1Decisions: EditorialDecision[] = [
        {
          id: 'dec-c1-false-start',
          decisionKind: 'REMOVE_FALSE_START',
          targetRange: { startSec: 10, endSec: 130 },
          intent: 'Remove opening false start delivery',
          actionPolicy: 'EXECUTE',
          evidenceRefs: ['ev-speech-c1'],
          knowledgeRefs: ['talking-head.rough-cut-pacing'],
          confidence: 0.95,
          rationale: 'Speaker restarted opening greeting at 02:10.',
        },
      ]

      plan = recordStageDecisions(plan, 'chap-proj-longform-45m-1', stage1Decisions, 'snap-stage-1')
      expect(plan.completedStages).toBe(1)
      expect(plan.reviewedChapterIds).toEqual(['chap-proj-longform-45m-1'])
      expect(plan.currentEstimatedDurationSec).toBe(2580) // 2700 - 120 = 2580s

      // Stage 2: Review Chapter 2, propose tightening 200s
      const stage2Decisions: EditorialDecision[] = [
        {
          id: 'dec-c2-tighten',
          decisionKind: 'TIGHTEN_PACING',
          targetRange: { startSec: 350, endSec: 550 },
          intent: 'Tighten repetitive explanation',
          actionPolicy: 'EXECUTE',
          evidenceRefs: ['ev-speech-c2'],
          knowledgeRefs: ['talking-head.rough-cut-pacing'],
          confidence: 0.92,
          rationale: 'Tightened duplicate setup phrasing.',
        },
      ]

      plan = recordStageDecisions(plan, 'chap-proj-longform-45m-2', stage2Decisions, 'snap-stage-2')
      expect(plan.completedStages).toBe(2)
      expect(plan.currentEstimatedDurationSec).toBe(2380) // 2580 - 200 = 2380s
    })
  })

  describe('Step 13, 24, 32 — Revision Safety & Conflict Detection', () => {
    it('detects revision mismatch when live timeline changes during an editing stage', () => {
      const projectMap = buildLongFormProjectMap({ projectId, projectRevision: 'rev-01', totalDurationSec, items })
      const plan = initializeLongFormWorkingPlan({
        projectMap,
        objective: { contentType: 'tutorial' },
      })

      // Human user edited timeline mid-turn -> live revision is now rev-02
      const check = validateStageRevisionLock(plan, 'rev-02')
      expect(check.valid).toBe(false)
      expect(check.conflictReason).toContain('Timeline revision changed from rev-01 to rev-02')
    })
  })

  describe('Step 16, 17, 25, 33 — Early Ripple Shift & Late Edit Semantic Anchoring', () => {
    it('correctly resolves timeline position for a late item after early edits shift time bounds', () => {
      // Simulate live timeline items after Edit A removes 90 seconds at 05:00
      const liveItems = [
        { id: 'item-c1-i1', timelineStartSec: 0, sourceStartSec: 0, sourceDurationSec: 15 },
        // Items between 05:00 and 30:00 shifted forward by 90s
        { id: 'item-c6-i1', timelineStartSec: 1410, sourceStartSec: 1500, sourceDurationSec: 15 }, // Shifted from 1500 to 1410
      ]

      const anchor = resolveSemanticAnchor({
        targetItemId: 'item-c6-i1',
        targetSourceStartSec: 1500,
        targetSourceDurationSec: 15,
        liveItems,
      })

      expect(anchor.resolved).toBe(true)
      // The late operation accurately targets the shifted timeline position (1410s) via stable itemId
      expect(anchor.currentTimelineStartSec).toBe(1410)
    })
  })

  describe('Step 18, 22, 35, 36 — Ask User Queue & Clean Chapter SKIP', () => {
    it('enqueues missing B-roll into askUserQueue and supports clean chapter SKIP without forced cuts', () => {
      const projectMap = buildLongFormProjectMap({ projectId, projectRevision, totalDurationSec, items })
      let plan = initializeLongFormWorkingPlan({ projectMap, objective: { contentType: 'tutorial' } })

      // Stage 3: Missing B-roll triggers ASK_USER
      const missingBrollDecision: EditorialDecision = {
        id: 'dec-c3-broll-missing',
        decisionKind: 'REQUEST_ASSET',
        targetRange: { startSec: 620, endSec: 625 },
        intent: 'Request missing code editor B-roll',
        actionPolicy: 'ASK_USER',
        evidenceRefs: [],
        knowledgeRefs: ['broll.motivation-and-placement'],
        confidence: 0.90,
        rationale: 'No code editor footage found in library for Chapter 3.',
      }

      plan = recordStageDecisions(plan, 'chap-proj-longform-45m-3', [missingBrollDecision])
      expect(plan.askUserQueue.length).toBe(1)
      expect(plan.askUserQueue[0]!.category).toBe('MISSING_ASSET')
      expect(plan.askUserQueue[0]!.question).toContain('No code editor footage found')

      // Stage 4: Clean Chapter 4 is already well-edited -> SKIP
      const cleanChapterDecision: EditorialDecision = {
        id: 'dec-c4-noop',
        decisionKind: 'NO_OP_CLEAN_SECTION',
        targetRange: { startSec: 900, endSec: 1200 },
        intent: 'Preserve well-paced chapter',
        actionPolicy: 'SKIP',
        evidenceRefs: [],
        knowledgeRefs: ['universal.economy-of-means'],
        confidence: 0.98,
        rationale: 'Chapter 4 is well-paced; zero edits required.',
      }

      plan = recordStageDecisions(plan, 'chap-proj-longform-45m-4', [cleanChapterDecision])
      expect(plan.completedStages).toBe(2)
      // Duration remains unchanged for clean chapter
      expect(plan.currentEstimatedDurationSec).toBe(2700)
    })
  })
})
