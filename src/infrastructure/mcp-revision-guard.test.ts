import { describe, expect, it } from 'vitest'
import { assertRevisionMatches } from './mcp-revision-guard'

describe('MCP revision guard', () => {
  it('rejects a stale mutation with the structured project revision contract', () => {
    try {
      assertRevisionMatches('revision-A', 'revision-B', 'video_move')
      throw new Error('expected revision guard to reject')
    } catch (error: any) {
      expect(error.code).toBe('REVISION_MISMATCH')
      expect(error.expected).toBe('revision-A')
      expect(error.actual).toBe('revision-B')
      expect(error.operation).toBe('video_move')
    }
  })

  it('accepts the current revision without changing state itself', () => {
    expect(() => assertRevisionMatches('revision-B', 'revision-B', 'video_move')).not.toThrow()
  })
})
