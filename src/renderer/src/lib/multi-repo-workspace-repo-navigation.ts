import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { WorkspaceRepoSelection } from '../../../shared/window-shortcut-policy'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { resolveMultiRepoExecutionHostId } from '@/lib/multi-repo-execution-host'

type RepoNavigationState = Pick<AppState, 'folderWorkspaces' | 'activeWorktreeId'>

export type WorkspaceRepoNavigationTarget = {
  workspaceKey: string
  folderWorkspace: FolderWorkspace
}

/** Strip order: the workspace folder first, then ready members. */
export function workspaceRepoEntries(folderWorkspace: FolderWorkspace): string[] {
  const memberWorktreeIds = (folderWorkspace.multiRepo?.members ?? []).flatMap((member) =>
    member.state === 'ready' && member.worktreeId ? [member.worktreeId] : []
  )
  return [folderWorkspaceKey(folderWorkspace.id), ...memberWorktreeIds]
}

export function resolveWorkspaceRepoTarget(
  state: RepoNavigationState,
  selection: WorkspaceRepoSelection
): WorkspaceRepoNavigationTarget | null {
  const { activeWorktreeId } = state
  if (!activeWorktreeId) {
    return null
  }
  for (const folderWorkspace of selectFolderWorkspaces(state)) {
    if (!folderWorkspace.multiRepo) {
      continue
    }
    const entries = workspaceRepoEntries(folderWorkspace)
    const currentIndex = entries.indexOf(activeWorktreeId)
    if (currentIndex === -1) {
      continue
    }
    const targetIndex =
      (currentIndex + (selection.kind === 'next' ? 1 : -1) + entries.length) % entries.length
    const workspaceKey = entries[targetIndex]
    return workspaceKey && workspaceKey !== activeWorktreeId
      ? { workspaceKey, folderWorkspace }
      : null
  }
  return null
}

export function activateWorkspaceRepoEntry(
  workspaceKey: string,
  folderWorkspace: FolderWorkspace
): void {
  const executionHostId = resolveMultiRepoExecutionHostId(folderWorkspace)
  activateAndRevealWorkspace(workspaceKey, {
    navigationIntent: 'user-open',
    ...(executionHostId ? { executionHostId } : {})
  })
}

export function selectWorkspaceRepoFromShortcut(selection: WorkspaceRepoSelection): void {
  const state = useAppStore.getState()
  if (state.activeView !== 'terminal' || state.activeModal === 'worktree-palette') {
    return
  }
  const target = resolveWorkspaceRepoTarget(state, selection)
  if (!target) {
    return
  }
  activateWorkspaceRepoEntry(target.workspaceKey, target.folderWorkspace)
}
