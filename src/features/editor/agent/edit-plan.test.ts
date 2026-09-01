import { describe, expect, it } from 'vitest'
import { normaliseEditPlan, validateEditPlanForV1 } from './edit-plan'
import { getEditingGuidance } from './editing-guidance'

const current = { projectId: 'project-a', projectRevision: 'timeline-fnv1a:123:4' }
const valid = {
  title: 'Tighten opening', goal: 'Remove two confirmed fillers.', projectId: current.projectId, projectRevision: current.projectRevision,
  evidenceIds: ['semantic:asset-a', 'script:opening'],
  operations: [{ id: 'remove-fillers', executor: 'video_apply_script', summary: 'Remove two um words.', risk: 'reversible', args: { confirm: false }, evidenceIds: ['script:opening'], verification: ['deterministic', 'perceptual'] }],
  limitations: ['Creator review is required before destructive edits.'],
}

describe('SCLIP edit plan contract', () => {
  it('accepts an evidence-grounded plan for the current live revision', () => {
    expect(normaliseEditPlan(valid, current)).toMatchObject({ schemaVersion: 1, operations: [{ id: 'remove-fillers' }] })
  })
  it('rejects stale plans before execution', () => {
    expect(() => normaliseEditPlan({ ...valid, projectRevision: 'timeline:old' }, current)).toThrow('EDIT_PLAN_REVISION_MISMATCH')
  })
  it('rejects operations that do not name their evidence and verification', () => {
    const bad = structuredClone(valid)
    bad.operations[0]!.evidenceIds = []
    expect(() => normaliseEditPlan(bad, current)).toThrow('at least one evidenceId')
  })
  it('rejects unknown dependencies and malformed affected ranges', () => {
    expect(() => normaliseEditPlan({ ...valid, operations: [{ ...valid.operations[0], dependsOn: ['missing'] }] }, current)).toThrow('depends on unknown')
    expect(() => normaliseEditPlan({ ...valid, operations: [{ ...valid.operations[0], affectedRange: { startFrame: 10, endFrame: 2 } }] }, current)).toThrow('affectedRange')
  })
  it('rejects multi-operation dependency cycles before a plan can be saved', () => {
    const first = { ...valid.operations[0], id: 'first', dependsOn: ['third'] }
    const second = { ...valid.operations[0], id: 'second', dependsOn: ['first'] }
    const third = { ...valid.operations[0], id: 'third', dependsOn: ['second'] }
    expect(() => normaliseEditPlan({ ...valid, operations: [first, second, third] }, current))
      .toThrow('EDIT_PLAN_DEPENDENCY_CYCLE: first -> third -> second -> first')
  })
  it('preserves optional execution context without changing the V1 schema', () => {
    const plan = normaliseEditPlan({ ...valid, operations: [{ ...valid.operations[0], intent: 'Tighten delivery', dependsOn: [], expectedOutcome: 'Shorter opening' }] }, current)
    expect(plan.schemaVersion).toBe(1)
    expect(plan.operations[0]).toMatchObject({ intent: 'Tighten delivery', expectedOutcome: 'Shorter opening' })
  })
  it('rejects bad executors, args, and stale evidence before mutation', () => {
    const plan = normaliseEditPlan(valid, current)
    expect(validateEditPlanForV1(plan, ['semantic:asset-a'])).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_EVIDENCE' }))
    expect(validateEditPlanForV1({ ...plan, operations: [{ ...plan.operations[0]!, executor: 'made_up_executor' }] }, plan.evidenceIds)).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_EXECUTOR' }))
    expect(validateEditPlanForV1({ ...plan, operations: [{ ...plan.operations[0]!, args: {} }] }, plan.evidenceIds)).toContainEqual(expect.objectContaining({ code: 'INVALID_EXECUTOR_ARGS' }))
  })
  it('accepts a grounded transform operation for a visible punch-in', () => {
    const plan = normaliseEditPlan({
      ...valid,
      operations: [{
        ...valid.operations[0], executor: 'video_update_transform',
        args: { item_id: 'clip-1', transform: { width: 1250, height: 703 } },
      }],
    }, current)
    expect(validateEditPlanForV1(plan, plan.evidenceIds)).toEqual([])
  })
})

describe('deterministic editing guidance', () => {
  it('returns only matching, traceable modules', () => {
    const result = getEditingGuidance(['hook', 'pacing'])
    expect(result.version).toBe('sclip-editing-guidance-v1')
    expect(result.modules.map((module) => module.id)).toEqual(['hook', 'pacing'])
    expect(result.modules.every((module) => module.sourceId)).toBe(true)
  })

  it('does not dump unrelated guidance', () => {
    expect(getEditingGuidance(['hook']).modules.map((module) => module.id)).toEqual(['hook'])
  })
})
