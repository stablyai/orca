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
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** Re-read current workspace attachments at action time so newly created issue workspaces are reused instead of duplicated. */
export function openLinearIssueWorkspaceOrStart(
  issue: LinearIssueAttachmentRef,
  startWorkspace: () => void
): 'opened' | 'started' | 'failed' {
  const state = useAppStore.getState()
  const attached = findLinearIssueWorkspaceAttachment(
    [...state.allWorktrees(), ...selectFolderWorkspaces(state).map(folderWorkspaceToWorktree)],
    issue
  )
  if (!attached) {
    startWorkspace()
    return 'started'
  }

  const workspaceScope = parseWorkspaceKey(attached.id)
  const activation =
    workspaceScope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
          navigationIntent: 'user-open',
          ...(attached.hostId ? { executionHostId: attached.hostId } : {})
        })
      : activateAndRevealWorktree(attached.id, {
          navigationIntent: 'user-open',
          ...(attached.hostId ? { executionHostId: attached.hostId } : {})
        })
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
