/**
 * Whether the copy shortcut should be left to the platform clipboard.
 *
 * Timeline shortcuts are registered on the document capture phase, which
 * otherwise wins over the browser's normal copy behavior. Inputs keep their
 * selection outside of `document.getSelection()`, so check them explicitly.
 */
export function hasNativeTextSelection(event: KeyboardEvent): boolean {
  const target = event.target

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.selectionStart !== target.selectionEnd
  }

  const selection = document.getSelection()
  return selection !== null && !selection.isCollapsed
}
