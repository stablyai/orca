// Why: Go to file closes a focus-trapped dialog. Cmd+F only reaches the editor
// while that editor holds keyboard focus (issue #29226).
const OPENED_EDITOR_FOCUS_SELECTORS = [
  '.monaco-editor textarea',
  '.rich-markdown-editor[contenteditable="true"]',
  '.markdown-preview'
]

export type OpenedEditorFocusTarget = {
  fileId: string
  worktreeId: string
}

function openedEditorRoot(doc: Document, target: OpenedEditorFocusTarget): Element | null {
  const fileId = CSS.escape(target.fileId)
  const worktreeId = CSS.escape(target.worktreeId)
  return doc.querySelector(
    `[data-editor-file-id="${fileId}"][data-editor-worktree-id="${worktreeId}"]`
  )
}

export function focusOpenedEditorSurface(
  target: OpenedEditorFocusTarget,
  doc: Document = document
): boolean {
  const root = openedEditorRoot(doc, target)
  if (!root) {
    return false
  }
  for (const selector of OPENED_EDITOR_FOCUS_SELECTORS) {
    const node = root.querySelector(selector)
    if (!(node instanceof HTMLElement)) {
      continue
    }
    node.focus()
    if (doc.activeElement === node || node.contains(doc.activeElement)) {
      return true
    }
  }
  return false
}

export function completeQuickOpenEditorHandoff(
  event: Event,
  openedEditor: OpenedEditorFocusTarget | null
): void {
  event.preventDefault()
  if (!openedEditor) {
    return
  }
  const focus = (): void => {
    focusOpenedEditorSurface(openedEditor)
  }
  focus()
  requestAnimationFrame(() => {
    requestAnimationFrame(focus)
  })
}
