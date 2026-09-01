import { describe, expect, it } from 'vitest'
import {
  InvalidArgumentError,
  validateItemUpdates,
  validateTransformUpdates,
} from './mcp-tool-contracts'

describe('MCP tool contracts', () => {
  it('rejects invalid timeline values before they reach FreeCut', () => {
    expect(() => validateItemUpdates({ fadeIn: true })).toThrow(InvalidArgumentError)
    const result = validateItemUpdates({ fadeOut: false }, false)
    expect(result).toMatchObject({ valid: false, error: { code: 'INVALID_ARGUMENT', field: 'fadeOut' } })
  })

  it('normalizes safe agent input explicitly', () => {
    const item = validateItemUpdates({ fadeIn: '0.5', volume: '-3.5', muted: 'true' })
    expect(item.sanitizedUpdates).toEqual({ fadeIn: 0.5, volume: -3.5, muted: true })
    expect(item.normalizedFields.fadeIn).toEqual({ from: '0.5', to: 0.5 })

    const transform = validateTransformUpdates({ opacity: 85, scaleX: '1.1' })
    expect(transform.sanitizedTransform).toEqual({ opacity: 0.85, scaleX: 1.1 })
    expect(transform.normalizedFields['transform.opacity']).toEqual({ from: 85, to: 0.85 })
  })
})
