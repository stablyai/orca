import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findLinearIssueWorkspaceAttachment,
  type LinearIssueAttachmentRef
} from '@/lib/linear-issue-workspace-attachment'

/**
 * Opens the workspace already attached to a Linear issue, or starts a new one.
 * Re-reads worktrees from the store so a workspace created since the last render
 * is still honoured instead of starting a duplicate.
 */
export function openLinearIssueWorkspaceOrStart(
  issue: LinearIssueAttachmentRef,
  startWorkspace: () => void
): 'opened' | 'started' | 'failed' {
  const state = useAppStore.getState()
  const attached = findLinearIssueWorkspaceAttachment(
    [...state.allWorktrees(), ...state.folderWorkspaces.map(folderWorkspaceToWorktree)],
    issue
  )
  if (!attached) {
    startWorkspace()
    return 'started'
  }

  const workspaceScope = parseWorkspaceKey(attached.id)
  const activation =
    workspaceScope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(
          workspaceScope.folderWorkspaceId,
          attached.hostId ? { executionHostId: attached.hostId } : undefined
        )
      : activateAndRevealWorktree(
          attached.id,
          attached.hostId ? { executionHostId: attached.hostId } : {}
        )
  if (activation === false) {
    toast.error(
      translate(
        'auto.lib.linear.issue.workspace.open.4f2c1d8a3b',
        'Unable to open the workspace attached to this issue.'
      )
    )
    return 'failed'
  }
  return 'opened'
}
