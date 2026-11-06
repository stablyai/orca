import { toast } from 'sonner'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { getLocalFileManager } from './local-file-manager-label'
import {
  getLocalPathOpenOwnerForRoute,
  getLocalPathOpenOwnerHostId,
  isRevealOrEditorOpenBlocked,
  showLocalPathOpenBlockedToast,
  type LocalPathOpenOwner
} from './local-path-open-guard'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { getConnectionIdFromState } from './connection-owner-resolution'
import type { AppState } from '@/store/types'

/** Menu label for showing a path in the OS file manager, as each platform names it. */
export function getRevealInFileManagerLabel(): string {
  switch (getLocalFileManager()) {
    case 'finder':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.revealInFinder',
        'Reveal in Finder'
      )
    case 'file-explorer':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.revealInFileExplorer',
        'Reveal in File Explorer'
      )
    case 'file-manager':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.openContainingFolder',
        'Open Containing Folder'
      )
  }
}

/** Resolve file owner from route and catalog: an unstamped server tab can appear local by route alone. */
export function getWorkspaceFileRevealOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined,
  route: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): ExecutionHostId | 'unresolved' {
  const routeOwner = getLocalPathOpenOwnerForRoute(route)
  if (routeOwner !== LOCAL_EXECUTION_HOST_ID || !worktreeId) {
    return routeOwner
  }
  return getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? 'unresolved'
}

/** Owner of an open editor file, as the editor header resolves it for Reveal and Copy Path. */
export function getOpenFileRevealOwner(
  state: AppState,
  file: {
    worktreeId: string
    externalSshTargetId?: string | null
    runtimeEnvironmentId?: string | null
  }
): ExecutionHostId | 'unresolved' {
  return getWorkspaceFileRevealOwner(state, file.worktreeId, {
    connectionId: file.externalSshTargetId ?? getConnectionIdFromState(state, file.worktreeId),
    runtimeEnvironmentId: file.runtimeEnvironmentId
  })
}

/** Shows a path in the OS file manager when this computer can reach it, and says why when it cannot. */
export async function revealInFileManager(path: string, owner: LocalPathOpenOwner): Promise<void> {
  const ownerHostId = getLocalPathOpenOwnerHostId(owner)
  if (isRevealOrEditorOpenBlocked(owner) || ownerHostId === 'unresolved') {
    showLocalPathOpenBlockedToast()
    return
  }
  const result = await window.api.shell.openInFileManager(path, ownerHostId)
  if (result.ok) {
    return
  }
  if (result.reason === 'remote-runtime-unsupported') {
    showLocalPathOpenBlockedToast()
    return
  }
  toast.error(
    result.reason === 'launch-failed'
      ? translate('auto.lib.reveal.in.file.manager.launchFailed', 'Could not reveal the file.')
      : translate(
          'auto.lib.reveal.in.file.manager.notFound',
          'File not found. It may have been moved or deleted.'
        )
  )
}
