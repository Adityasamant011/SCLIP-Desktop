/**
 * Strict input contracts at SCLIP's agent boundary.
 *
 * These deliberately protect the existing FreeCut timeline store rather than
 * introducing a second editor model. They accept only safe values before an
 * MCP request reaches the live editor.
 */

export interface NormalizedFieldInfo {
  from: unknown
  to: unknown
}

type ContractError = {
  code: 'INVALID_ARGUMENT'
  field: string
  expected: string
  received: string
  message: string
}

export interface ContractValidationResult {
  valid: boolean
  sanitizedUpdates: Record<string, unknown>
  normalizedFields: Record<string, NormalizedFieldInfo>
  error?: ContractError
}

export interface TransformValidationResult {
  valid: boolean
  sanitizedTransform: Record<string, unknown>
  normalizedFields: Record<string, NormalizedFieldInfo>
  error?: ContractError
}

export class InvalidArgumentError extends Error {
  readonly code = 'INVALID_ARGUMENT'
  readonly field: string
  readonly expected: string
  readonly received: string

  constructor(field: string, expected: string, received: unknown) {
    const receivedType = received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received
    super(`INVALID_ARGUMENT on field '${field}': expected ${expected}, received ${receivedType}`)
    this.name = 'InvalidArgumentError'
    this.field = field
    this.expected = expected
    this.received = receivedType
  }
}

type NumericSpec = { expected: string; min?: number; max?: number }

const ITEM_NUMERIC_FIELDS: Record<string, NumericSpec> = {
  fadeIn: { expected: 'finite number in seconds (e.g. 0.5)', min: 0, max: 60 },
  fadeOut: { expected: 'finite number in seconds (e.g. 0.5)', min: 0, max: 60 },
  audioFadeIn: { expected: 'finite number in seconds (e.g. 0.5)', min: 0, max: 60 },
  audioFadeOut: { expected: 'finite number in seconds (e.g. 0.5)', min: 0, max: 60 },
  audioFadeInCurve: { expected: 'finite number in range [-1, 1]', min: -1, max: 1 },
  audioFadeOutCurve: { expected: 'finite number in range [-1, 1]', min: -1, max: 1 },
  audioFadeInCurveX: { expected: 'finite number in range [0, 1]', min: 0, max: 1 },
  audioFadeOutCurveX: { expected: 'finite number in range [0, 1]', min: 0, max: 1 },
  audioPitchSemitones: { expected: 'integer semitones in range [-24, 24]', min: -24, max: 24 },
  audioPitchCents: { expected: 'cents in range [-100, 100]', min: -100, max: 100 },
  volume: { expected: 'decibels in range [-60, 12]', min: -60, max: 12 },
  speed: { expected: 'speed multiplier in range [0.1, 100]', min: 0.1, max: 100 },
  fontSize: { expected: 'positive font size in points', min: 1, max: 1000 },
  letterSpacing: { expected: 'number', min: -100, max: 500 },
  lineHeight: { expected: 'positive line height', min: 0.1, max: 10 },
  strokeWidth: { expected: 'non-negative stroke width', min: 0, max: 500 },
  shadowBlur: { expected: 'non-negative shadow blur', min: 0, max: 500 },
  shadowOffsetX: { expected: 'shadow offset X in pixels' },
  shadowOffsetY: { expected: 'shadow offset Y in pixels' },
}

const ITEM_BOOLEAN_FIELDS = new Set(['muted', 'visible', 'locked', 'isReversed', 'audioDucking'])
const ITEM_STRING_FIELDS = new Set([
  'label', 'text', 'fontFamily', 'fontWeight', 'fontStyle', 'color', 'backgroundColor',
  'textAlign', 'strokeColor', 'shadowColor', 'blendMode',
])

const TRANSFORM_NUMERIC_FIELDS: Record<string, NumericSpec> = {
  x: { expected: 'finite number (pixels)' },
  y: { expected: 'finite number (pixels)' },
  width: { expected: 'positive finite number (pixels)', min: 1, max: 16384 },
  height: { expected: 'positive finite number (pixels)', min: 1, max: 16384 },
  rotation: { expected: 'finite number in degrees', min: -3600, max: 3600 },
  opacity: { expected: 'number in range [0, 1] or percentage [0, 100]', min: 0, max: 1 },
  scaleX: { expected: 'finite number scale multiplier', min: -100, max: 100 },
  scaleY: { expected: 'finite number scale multiplier', min: -100, max: 100 },
  anchorX: { expected: 'number in range [0, 1]', min: 0, max: 1 },
  anchorY: { expected: 'number in range [0, 1]', min: 0, max: 1 },
  cornerRadius: { expected: 'non-negative number', min: 0, max: 4096 },
}

const TRANSFORM_BOOLEAN_FIELDS = new Set(['flipHorizontal', 'flipVertical'])

function failure(field: string, expected: string, value: unknown) {
  return new InvalidArgumentError(field, expected, value)
}

function coerceNumber(
  field: string,
  value: unknown,
  spec: NumericSpec,
  normalizedFields: Record<string, NormalizedFieldInfo>,
): number {
  if (typeof value === 'boolean') throw failure(field, spec.expected, value)
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isFinite(numberValue)) throw failure(field, spec.expected, value)
  if (typeof value === 'string') normalizedFields[field] = { from: value, to: numberValue }
  const clamped = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, numberValue))
  if (clamped !== numberValue) normalizedFields[field] = { from: value, to: clamped }
  return clamped
}

function asResult<T extends 'item' | 'transform'>(
  operation: () => { values: Record<string, unknown>; normalizedFields: Record<string, NormalizedFieldInfo> },
  kind: T,
  throwOnError: boolean,
): T extends 'item' ? ContractValidationResult : TransformValidationResult {
  try {
    const { values, normalizedFields } = operation()
    return (kind === 'item'
      ? { valid: true, sanitizedUpdates: values, normalizedFields }
      : { valid: true, sanitizedTransform: values, normalizedFields }) as T extends 'item' ? ContractValidationResult : TransformValidationResult
  } catch (error) {
    if (throwOnError) throw error
    const invalid = error as InvalidArgumentError
    const result = {
      valid: false,
      normalizedFields: {},
      error: {
        code: 'INVALID_ARGUMENT' as const,
        field: invalid.field,
        expected: invalid.expected,
        received: invalid.received,
        message: invalid.message,
      },
    }
    return (kind === 'item'
      ? { ...result, sanitizedUpdates: {} }
      : { ...result, sanitizedTransform: {} }) as T extends 'item' ? ContractValidationResult : TransformValidationResult
  }
}

export function validateItemUpdates(rawUpdates: Record<string, unknown>, throwOnError = true): ContractValidationResult {
  return asResult(() => {
    const values: Record<string, unknown> = {}
    const normalizedFields: Record<string, NormalizedFieldInfo> = {}
    for (const [key, value] of Object.entries(rawUpdates)) {
      if (value === undefined) continue
      if (key in ITEM_NUMERIC_FIELDS) values[key] = coerceNumber(key, value, ITEM_NUMERIC_FIELDS[key]!, normalizedFields)
      else if (ITEM_BOOLEAN_FIELDS.has(key)) {
        if (typeof value === 'boolean') values[key] = value
        else if (value === 'true' || value === 'false') {
          values[key] = value === 'true'
          normalizedFields[key] = { from: value, to: values[key] }
        } else throw failure(key, 'boolean (true or false)', value)
      } else if (ITEM_STRING_FIELDS.has(key)) {
        if (typeof value !== 'string') throw failure(key, 'string', value)
        values[key] = value
      } else values[key] = value
    }
    return { values, normalizedFields }
  }, 'item', throwOnError)
}

export function validateTransformUpdates(rawTransform: Record<string, unknown>, throwOnError = true): TransformValidationResult {
  return asResult(() => {
    const values: Record<string, unknown> = {}
    const normalizedFields: Record<string, NormalizedFieldInfo> = {}
    for (const [key, value] of Object.entries(rawTransform)) {
      if (value === undefined) continue
      const field = `transform.${key}`
      if (key in TRANSFORM_NUMERIC_FIELDS) {
        // Opacity accepts either a ratio or a percentage, so normalize before
        // its final [0, 1] clamp.
        const spec = TRANSFORM_NUMERIC_FIELDS[key]!
        let numberValue = coerceNumber(
          field,
          value,
          key === 'opacity' ? { ...spec, max: undefined } : spec,
          normalizedFields,
        )
        if (key === 'opacity' && numberValue > 1 && numberValue <= 100) {
          numberValue /= 100
          normalizedFields[field] = { from: value, to: numberValue }
        }
        if (spec.max !== undefined && numberValue > spec.max) {
          numberValue = spec.max
          normalizedFields[field] = { from: value, to: numberValue }
        }
        values[key] = numberValue
      } else if (TRANSFORM_BOOLEAN_FIELDS.has(key)) {
        if (typeof value === 'boolean') values[key] = value
        else if (value === 'true' || value === 'false') {
          values[key] = value === 'true'
          normalizedFields[field] = { from: value, to: values[key] }
        } else throw failure(field, 'boolean (true or false)', value)
      } else values[key] = value
    }
    return { values, normalizedFields }
  }, 'transform', throwOnError)
}
