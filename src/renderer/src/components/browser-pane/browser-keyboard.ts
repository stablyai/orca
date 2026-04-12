type EditableTargetLike = {
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

export function isEditableKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean {
  const element =
    target && typeof target === 'object' && ('closest' in target || 'isContentEditable' in target)
      ? (target as EditableTargetLike)
      : null
  if (!element) {
    return false
  }

  // Why: grab-mode single-key shortcuts should never fire while the user is
  // typing into the browser chrome itself (address bar/search fields) or any
  // other editable control. Treat nested elements inside those controls as
  // editable too so composition wrappers or icons inside the input don't cause
  // C/S to be swallowed unexpectedly.
  const editableHost = element.closest?.('input, textarea, [contenteditable="true"]')
  if (editableHost) {
    return true
  }

  return element.isContentEditable === true
}
