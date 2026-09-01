/**
 * SCLIP's reviewable plan contract. Hermes remains the one general planner;
 * this module only validates and normalises the plan it proposes before the
 * plan is stored or sent to FreeCut's deterministic executors.
 */

export type EditPlanRisk = 'read_only' | 'reversible' | 'destructive'

export interface EditPlanOperation {
  id: string
  executor: string
  summary: string
  risk: EditPlanRisk
  args: Record<string, unknown>
  evidenceIds: string[]
  verification: Array<'deterministic' | 'perceptual' | 'editorial'>
  /** Why this operation serves the plan goal; supplied by Hermes, not inferred here. */
  intent?: string
  reason?: string
  dependsOn?: string[]
  affectedRange?: { startFrame: number; endFrame: number }
  expectedOutcome?: string
}

export const EDIT_PLAN_EXECUTORS = [
  'video_apply_script',
  'video_update_item',
  'video_update_transform',
  'video_add_clip',
  'video_add_track',
] as const
export type EditPlanExecutor = typeof EDIT_PLAN_EXECUTORS[number]

export interface EditPlanValidationIssue {
  code: 'UNKNOWN_EVIDENCE' | 'UNKNOWN_EXECUTOR' | 'INVALID_EXECUTOR_ARGS'
  operationId?: string
  message: string
}

/** V1 execution validation stays deterministic and independent of Hermes. */
export function validateEditPlanForV1(plan: SclipEditPlan, knownEvidenceIds: Iterable<string>): EditPlanValidationIssue[] {
  const evidence = new Set(knownEvidenceIds)
  const issues: EditPlanValidationIssue[] = []
  for (const evidenceId of plan.evidenceIds) {
    if (!evidence.has(evidenceId)) issues.push({ code: 'UNKNOWN_EVIDENCE', message: `Evidence '${evidenceId}' is not current project evidence.` })
  }
  for (const operation of plan.operations) {
    if (!EDIT_PLAN_EXECUTORS.includes(operation.executor as EditPlanExecutor)) {
      issues.push({ code: 'UNKNOWN_EXECUTOR', operationId: operation.id, message: `Executor '${operation.executor}' is not approved for EditPlan V1.` })
    } else if (operation.executor === 'video_apply_script' && !Array.isArray(operation.args.operations)) {
      issues.push({ code: 'INVALID_EXECUTOR_ARGS', operationId: operation.id, message: 'video_apply_script requires args.operations.' })
    } else if (operation.executor === 'video_update_item' && (!operation.args.item_id || !operation.args.updates)) {
      issues.push({ code: 'INVALID_EXECUTOR_ARGS', operationId: operation.id, message: 'video_update_item requires args.item_id and args.updates.' })
    } else if (operation.executor === 'video_update_transform' && (!operation.args.item_id || !operation.args.transform)) {
      issues.push({ code: 'INVALID_EXECUTOR_ARGS', operationId: operation.id, message: 'video_update_transform requires args.item_id and args.transform.' })
    } else if (operation.executor === 'video_add_clip' && (!operation.args.media_id || !operation.args.track_id)) {
      issues.push({ code: 'INVALID_EXECUTOR_ARGS', operationId: operation.id, message: 'video_add_clip requires args.media_id and args.track_id.' })
    } else if (operation.executor === 'video_add_track' && !operation.args.kind) {
      issues.push({ code: 'INVALID_EXECUTOR_ARGS', operationId: operation.id, message: 'video_add_track requires args.kind.' })
    }
  }
  return issues
}

export interface SclipEditPlan {
  schemaVersion: 1
  title: string
  goal: string
  projectId: string
  projectRevision: string
  evidenceIds: string[]
  operations: EditPlanOperation[]
  limitations: string[]
}

function uniqueNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim()] : [])))
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalAffectedRange(value: unknown, operationId: string): EditPlanOperation['affectedRange'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`operation ${operationId} affectedRange must be an object`)
  const range = value as Record<string, unknown>
  const startFrame = Number(range.startFrame ?? range.start_frame)
  const endFrame = Number(range.endFrame ?? range.end_frame)
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame < startFrame) {
    throw new Error(`operation ${operationId} affectedRange must contain ordered non-negative frames`)
  }
  return { startFrame, endFrame }
}

/** Reject vague or ungrounded plans before they become durable state. */
export function normaliseEditPlan(value: unknown, expected: { projectId: string; projectRevision: string }): SclipEditPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plan must be a structured object')
  const source = value as Record<string, unknown>
  const title = typeof source.title === 'string' ? source.title.trim() : ''
  const goal = typeof source.goal === 'string' ? source.goal.trim() : ''
  const projectId = String(source.projectId ?? source.project_id ?? '')
  const projectRevision = String(source.projectRevision ?? source.project_revision ?? '')
  if (!title || !goal) throw new Error('plan.title and plan.goal are required')
  if (projectId !== expected.projectId) throw new Error('EDIT_PLAN_PROJECT_MISMATCH: plan.projectId must target the open project')
  if (projectRevision !== expected.projectRevision) throw new Error('EDIT_PLAN_REVISION_MISMATCH: re-inspect the current timeline before saving this plan')
  if (!Array.isArray(source.operations) || source.operations.length === 0) throw new Error('plan.operations must contain at least one operation')

  const operationIds = new Set<string>()
  const operations = source.operations.map((raw, index): EditPlanOperation => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`operation ${index} must be an object`)
    const operation = raw as Record<string, unknown>
    const id = typeof operation.id === 'string' ? operation.id.trim() : ''
    const executor = typeof operation.executor === 'string' ? operation.executor.trim() : ''
    const summary = typeof operation.summary === 'string' ? operation.summary.trim() : ''
    const risk = operation.risk
    if (!id || !executor || !summary) throw new Error(`operation ${index} needs id, executor, and summary`)
    if (operationIds.has(id)) throw new Error(`operation id '${id}' is duplicated`)
    operationIds.add(id)
    if (risk !== 'read_only' && risk !== 'reversible' && risk !== 'destructive') throw new Error(`operation ${id} has an invalid risk`)
    if (!operation.args || typeof operation.args !== 'object' || Array.isArray(operation.args)) throw new Error(`operation ${id} needs structured args`)
    const evidenceIds = uniqueNonEmptyStrings(operation.evidenceIds ?? operation.evidence_ids)
    if (!evidenceIds.length) throw new Error(`operation ${id} needs at least one evidenceId`)
    const verification = uniqueNonEmptyStrings(operation.verification)
      .filter((method): method is EditPlanOperation['verification'][number] => method === 'deterministic' || method === 'perceptual' || method === 'editorial')
    if (!verification.length) throw new Error(`operation ${id} needs at least one verification method`)
    const dependsOn = uniqueNonEmptyStrings(operation.dependsOn ?? operation.depends_on)
    if (dependsOn.includes(id)) throw new Error(`operation ${id} cannot depend on itself`)
    return {
      id, executor, summary, risk, args: operation.args as Record<string, unknown>, evidenceIds, verification,
      ...(optionalText(operation.intent) ? { intent: optionalText(operation.intent) } : {}),
      ...(optionalText(operation.reason) ? { reason: optionalText(operation.reason) } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(optionalAffectedRange(operation.affectedRange ?? operation.affected_range, id) ? { affectedRange: optionalAffectedRange(operation.affectedRange ?? operation.affected_range, id) } : {}),
      ...(optionalText(operation.expectedOutcome ?? operation.expected_outcome) ? { expectedOutcome: optionalText(operation.expectedOutcome ?? operation.expected_outcome) } : {}),
    }
  })
  const evidenceIds = uniqueNonEmptyStrings(source.evidenceIds ?? source.evidence_ids)
  if (!evidenceIds.length) throw new Error('plan.evidenceIds must name the evidence used')
  const referenced = new Set(evidenceIds)
  for (const operation of operations) {
    for (const evidenceId of operation.evidenceIds) {
      if (!referenced.has(evidenceId)) throw new Error(`operation ${operation.id} references evidence '${evidenceId}' missing from plan.evidenceIds`)
    }
  }
  const operationIdsSet = new Set(operations.map((operation) => operation.id))
  for (const operation of operations) {
    for (const dependency of operation.dependsOn ?? []) {
      if (!operationIdsSet.has(dependency)) throw new Error(`operation ${operation.id} depends on unknown operation '${dependency}'`)
    }
  }
  // A dependency graph can be locally valid while still being impossible to
  // execute. Reject every cycle before a plan is saved so execution never has
  // to guess whether a skipped operation is waiting for a dependency that can
  // never complete.
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const visit = (operationId: string) => {
    if (visiting.has(operationId)) {
      const cycle = [...path.slice(path.indexOf(operationId)), operationId]
      throw new Error(`EDIT_PLAN_DEPENDENCY_CYCLE: ${cycle.join(' -> ')}`)
    }
    if (visited.has(operationId)) return
    visiting.add(operationId)
    path.push(operationId)
    for (const dependency of operationsById.get(operationId)?.dependsOn ?? []) visit(dependency)
    path.pop()
    visiting.delete(operationId)
    visited.add(operationId)
  }
  for (const operation of operations) visit(operation.id)
  return {
    schemaVersion: 1, title, goal, projectId, projectRevision, evidenceIds, operations,
    limitations: uniqueNonEmptyStrings(source.limitations),
  }
}
