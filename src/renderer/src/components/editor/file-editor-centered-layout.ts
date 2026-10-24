export function isFileEditorCenteredLayoutEnabled(
  editorCenteredLayout: boolean | undefined
): boolean {
  return editorCenteredLayout === true
}

// Why: the overflow menu hides this on diff/changes surfaces; the shortcut must match (#31236).
export function canToggleFileEditorCenteredLayout(args: {
  mode: 'edit' | 'diff' | 'conflict-review' | 'markdown-preview' | 'check-details'
  isChangesMode: boolean
}): boolean {
  return args.mode !== 'diff' && !args.isChangesMode
}

export function buildFileEditorCenteredLayoutShellClassName(
  editorCenteredLayout: boolean | undefined
): string {
  if (!isFileEditorCenteredLayoutEnabled(editorCenteredLayout)) {
    return 'h-full min-h-0 w-full'
  }
  return 'flex h-full min-h-0 w-full justify-center bg-editor-surface'
}

export function buildFileEditorCenteredLayoutContentClassName(
  editorCenteredLayout: boolean | undefined
): string {
  if (!isFileEditorCenteredLayoutEnabled(editorCenteredLayout)) {
    return 'h-full min-h-0 w-full'
  }
  // Why: max-w-4xl (~896px) is the closest token to VS Code's ~900px centered column.
  return 'h-full min-h-0 w-full min-w-0 max-w-4xl'
}
