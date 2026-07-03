import type { DiffSection } from './diff-section-types'

type DiffSectionPopoverTarget = {
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

export async function submitDiffSectionComment({
  addDiffComment,
  body,
  onAddLineComment,
  popover,
  section,
  worktreeId
}: {
  addDiffComment: AddDiffComment
  body: string
  onAddLineComment?: (
    section: DiffSection,
    args: {
      lineNumber: number
      startLine?: number
      body: string
    }
  ) => Promise<boolean>
  popover: DiffSectionPopoverTarget
  section: DiffSection
  worktreeId?: string
}): Promise<boolean> {
  if (onAddLineComment) {
    return onAddLineComment(section, {
      lineNumber: popover.lineNumber,
      startLine: popover.startLine,
      body
    })
  }
  if (!worktreeId) {
    return false
  }
  // Why: await persistence before closing the popover. If the store rolls back
  // the optimistic insert, keep the user's draft open so they can retry.
  const result = await addDiffComment({
    worktreeId,
    filePath: section.path,
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
