type EditableTargetLike = {
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

const EDITOR_SURFACE_SELECTOR = [
  '.monaco-editor',
  '.diff-editor',
  '.rich-markdown-editor',
  '.rich-markdown-editor-shell'
].join(', ')

function asEditableTarget(
  target: EventTarget | EditableTargetLike | null
): EditableTargetLike | null {
  return target &&
    typeof target === 'object' &&
    ('closest' in target || 'isContentEditable' in target)
    ? (target as EditableTargetLike)
    : null
}

export function isEditorSurfaceKeyboardTarget(
  target: EventTarget | EditableTargetLike | null
): boolean {
  return Boolean(asEditableTarget(target)?.closest?.(EDITOR_SURFACE_SELECTOR))
}

export function isEditableKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean {
  const element = asEditableTarget(target)
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
      EDITOR_SURFACE_SELECTOR
    ].join(', ')
  )
  if (editableHost) {
    return true
  }

  return element.isContentEditable === true
}
