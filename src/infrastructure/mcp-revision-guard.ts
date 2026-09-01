export type RevisionMismatch = {
  code: 'REVISION_MISMATCH'
  expected: string
  actual: string
  operation: string
}

export function requireExpectedRevision(expectedRevision: unknown, operation: string): string {
  if (typeof expectedRevision === 'string' && expectedRevision) return expectedRevision
  const error = new Error(`REVISION_REQUIRED: ${operation} requires expected_revision from video_get_project`)
  Object.assign(error, { code: 'REVISION_REQUIRED', operation })
  throw error
}

/** Keep every browser executor's stale-state error machine-readable. */
export function assertRevisionMatches(
  expectedRevision: unknown,
  actualRevision: string,
  operation: string,
): void {
  const expected = requireExpectedRevision(expectedRevision, operation)
  if (expected === actualRevision) return
  const detail: RevisionMismatch = {
    code: 'REVISION_MISMATCH', expected, actual: actualRevision, operation,
  }
  const error = new Error(`REVISION_MISMATCH: expected '${expected}', but current revision is '${actualRevision}'`)
  Object.assign(error, detail)
  throw error
}
