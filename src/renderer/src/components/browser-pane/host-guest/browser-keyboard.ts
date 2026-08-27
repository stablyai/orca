type EditableTargetLike = {
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

type TextSelectionLike = {
  isCollapsed?: boolean
  toString: () => string
}

// Why: the browser pane's global shortcuts repurpose keys the rest of the app still needs for
// native copy, and isEditableKeyboardTarget only exempts focusable editors — prose surfaces such
// as the chat transcript are plain elements it can never match. A live selection is the surface-
// independent signal that the user is copying text. Guest selections live in the <webview>'s own
// document and never reach window.getSelection(), so grabbing a page element is unaffected.
export function hasHostTextSelection(
  selection: TextSelectionLike | null = typeof window === 'undefined' ? null : window.getSelection()
): boolean {
  if (!selection || selection.isCollapsed === true) {
    return false
  }
  return selection.toString().trim() !== ''
}

export function isEditableKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean {
  const element =
    target && typeof target === 'object' && ('closest' in target || 'isContentEditable' in target)
      ? (target as EditableTargetLike)
      : null
  if (!element) {
    return false
  }

  // Why: Browser panes stay mounted beside editor splits, so their global
  // shortcut listeners must treat editor surfaces as editable too.
  const editableHost = element.closest?.(
    [
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '.monaco-editor',
      '.diff-editor',
      '.rich-markdown-editor',
      '.rich-markdown-editor-shell'
    ].join(', ')
  )
  if (editableHost) {
    return true
  }

  return element.isContentEditable === true
}
