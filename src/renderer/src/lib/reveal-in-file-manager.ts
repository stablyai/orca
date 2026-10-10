import { toast } from 'sonner'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { getLocalFileManager } from './local-file-manager-label'
import {
  getLocalPathOpenOwnerForRoute,
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast,
  type LocalPathOpenOwner
} from './local-path-open-guard'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

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

/**
 * The host that owns a workspace file. A route that reads as local is confirmed against the
 * catalog row, because a server workspace whose tab carries no owner stamp also reads as local.
 */
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

/** Shows a path in the OS file manager when this computer owns it, and says why when it cannot. */
export async function revealInFileManager(path: string, owner: LocalPathOpenOwner): Promise<void> {
  if (isLocalPathOpenBlocked(owner)) {
    showLocalPathOpenBlockedToast()
    return
  }
  const result = await window.api.shell.openInFileManager(path, LOCAL_EXECUTION_HOST_ID)
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
