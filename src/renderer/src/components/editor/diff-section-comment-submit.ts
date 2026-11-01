import type { AppState } from '@/store'
import type { DiffCommentOwner } from '@/store/diff-comment-owner'
import type { DiffSection } from './diff-section-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type DiffSectionCommentTarget = {
  lineNumber: number
  startLine?: number
}

export async function submitDiffSectionComment({
  owner,
  addDiffComment,
  body,
  onAddLineComment,
  target,
  section,
  worktreeId
}: {
  owner: DiffCommentOwner | null
  addDiffComment: AppState['addDiffComment']
  body: string
  onAddLineComment?: (
    section: DiffSection,
    args: {
      lineNumber: number
      startLine?: number
      body: string
    }
  ) => Promise<boolean>
  target: DiffSectionCommentTarget
  section: DiffSection
  worktreeId?: string
}): Promise<boolean> {
  if (onAddLineComment) {
    return onAddLineComment(section, {
      lineNumber: target.lineNumber,
      startLine: target.startLine,
      body
    })
  }
  if (!worktreeId || !owner) {
    return false
  }
  // Close only after persistence succeeds; rollback must leave the draft available for retry.
  const result = await addDiffComment(owner, {
    worktreeId,
    filePath: section.path,
    source: 'diff',
    startLine: target.startLine,
    lineNumber: target.lineNumber,
    body,
    side: 'modified'
  })
  if (!result) {
    toast.error(translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment'))
  }
  return Boolean(result)
}
