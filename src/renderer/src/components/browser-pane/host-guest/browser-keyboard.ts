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

  // Mounted browser panes share windows with editor splits; their global shortcuts must respect editable editor surfaces.
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
