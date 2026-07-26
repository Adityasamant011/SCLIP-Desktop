import { describe, expect, it } from 'vitest'
import { shouldPreferDomPlayerForGizmo } from './gizmo-preview-presentation'

describe('shouldPreferDomPlayerForGizmo', () => {
  it.each(['text', 'shape'] as const)(
    'uses the live DOM player for %s gizmo previews',
    (itemType) => {
      expect(shouldPreferDomPlayerForGizmo(false, itemType)).toBe(true)
    },
  )

  it('keeps an effected underlay rendered while a shape transform is previewed', () => {
    expect(shouldPreferDomPlayerForGizmo(true, 'shape')).toBe(false)
  })

  it('does not change presentation for media gizmos', () => {
    expect(shouldPreferDomPlayerForGizmo(false, 'video')).toBe(false)
  })
})
