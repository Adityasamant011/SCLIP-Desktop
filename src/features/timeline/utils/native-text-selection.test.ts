import { afterEach, describe, expect, it } from 'vitest'
import { hasNativeTextSelection } from './native-text-selection'

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('hasNativeTextSelection', () => {
  it('allows native copy for selected document text', () => {
    const text = document.createTextNode('Copy this text')
    document.body.append(text)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 4)
    document.getSelection()?.addRange(range)

    expect(hasNativeTextSelection(new KeyboardEvent('keydown'))).toBe(true)
  })

  it('allows native copy for selected input text', () => {
    const input = document.createElement('input')
    input.value = 'Copy this text'
    document.body.append(input)
    input.setSelectionRange(0, 4)

    let result = false
    input.addEventListener('keydown', (event) => {
      result = hasNativeTextSelection(event)
    })
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))

    expect(result).toBe(true)
  })

  it('does not claim a collapsed document selection', () => {
    const text = document.createTextNode('Copy this text')
    document.body.append(text)
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    document.getSelection()?.addRange(range)

    expect(hasNativeTextSelection(new KeyboardEvent('keydown'))).toBe(false)
  })
})
