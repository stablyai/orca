import { translate } from '@/i18n/i18n'
import type { AppState } from '../../types'
import type { NewBrowserTabProfile } from './browser-slice-contract'
import { findWorktreeById } from '../worktree-helpers'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../../workspace-record-selectors'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import {
  getManagedBrowserProfileOwner,
  type ManagedBrowserProfileOwner
} from '../../../../../shared/browser-profile-scope'

/** Profile a new tab gets when its caller names none: the workspace's own under a repo or workspace scope, else the host default. */
export function resolveNewBrowserTabProfile(
  state: AppState,
  worktreeId: string,
  hostId: ExecutionHostId
): NewBrowserTabProfile {
  const hostKind = parseExecutionHostId(hostId)?.kind
  // Why local and SSH only: those pages render on this desktop's profiles; a paired host's pages use its own.
  const owner =
    hostKind === 'local' || hostKind === 'ssh'
      ? getManagedBrowserProfileOwner(state.settings?.browserProfileScope, worktreeId)
      : null
  if (owner) {
    return state.ensureManagedBrowserSessionProfile(
      owner,
      managedProfileLabel(state, owner, worktreeId)
    )
  }
  return {
    sessionProfileId:
      state.defaultBrowserSessionProfileIdByHostId[hostId] ?? state.defaultBrowserSessionProfileId
  }
}

function managedProfileLabel(
  state: AppState,
  owner: ManagedBrowserProfileOwner,
  worktreeId: string
): string {
  if (owner.kind === 'repo') {
    const name = state.repos.find((repo) => repo.id === owner.id)?.displayName ?? owner.id
    return translate('settings.browser.profileScope.repoProfileLabel', 'Repo: {{name}}', { name })
  }
  const scope = parseWorkspaceKey(worktreeId)
  const name =
    (scope?.type === 'folder'
      ? selectFolderWorkspaces(state).find((folder) => folder.id === scope.folderWorkspaceId)?.name
      : findWorktreeById(selectWorktreesByRepo(state), worktreeId)?.displayName) || worktreeId
  return translate('settings.browser.profileScope.worktreeProfileLabel', 'Workspace: {{name}}', {
    name
  })
}
