import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { findBeadsIssueWorkspaceAttachment } from '@/lib/beads-issue-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { TaskPageBeadsIssueRow } from './task-page-beads-issues'

export async function copyBeadsIssueText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.TaskPage.beadsCopySuccess', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.TaskPage.beadsCopyFailure', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

// Mirrors TaskPage's handleOpenOrUseGitHubWorkItem: re-resolve at click time so a just-archived attachment falls back to Start.
export function openOrStartBeadsWorkspace(
  row: TaskPageBeadsIssueRow,
  onStartWorkspace: (row: TaskPageBeadsIssueRow) => void
): void {
  const currentAttached = findBeadsIssueWorkspaceAttachment(
    useAppStore.getState().allWorktrees(),
    row.sourceContext.repoId,
    row.issue.id
  )
  if (!currentAttached) {
    onStartWorkspace(row)
    return
  }
  if (activateAndRevealWorktree(currentAttached.id) === false) {
    toast.error(
      translate(
        'auto.components.TaskPage.585dba2989',
        'Unable to open the workspace attached to this issue.'
      )
    )
  }
}
