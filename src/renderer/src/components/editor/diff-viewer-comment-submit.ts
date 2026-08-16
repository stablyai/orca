type DiffViewerPopoverTarget = {
  lineNumber: number
  startLine?: number
}

type AddDiffComment = (args: {
  worktreeId: string
  filePath: string
  source: 'diff'
  startLine?: number
  lineNumber: number
  body: string
  side: 'modified'
}) => Promise<unknown>

/** Single-file DiffViewer variant of submitDiffSectionComment: resolves to
 *  whether the comment persisted, so the caller keeps the draft open on failure. */
export async function submitDiffViewerComment({
  addDiffComment,
  body,
  onAddLineComment,
  popover,
  relativePath,
  worktreeId
}: {
  addDiffComment: AddDiffComment
  body: string
  onAddLineComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  popover: DiffViewerPopoverTarget
  relativePath: string
  worktreeId?: string
}): Promise<boolean> {
  if (onAddLineComment) {
    return onAddLineComment({
      lineNumber: popover.lineNumber,
      startLine: popover.startLine,
      body
    })
  }
  if (!worktreeId) {
    return false
  }
  // Why: await persistence — a failed save keeps the popover open for retry
  // instead of losing the draft.
  const result = await addDiffComment({
    worktreeId,
    filePath: relativePath,
    source: 'diff',
    startLine: popover.startLine,
    lineNumber: popover.lineNumber,
    body,
    side: 'modified'
  })
  if (!result) {
    console.error('Failed to add diff comment — draft preserved')
  }
  return Boolean(result)
}
