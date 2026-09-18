import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { httpLinkActionDestinationsFor } from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-tab-open'
import { resolvePaneWslDistro } from '../terminal-pane/terminal-pane-wsl-distro'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'

export function createPreviewTerminalLinkContext(
  workspace: PreviewTerminalWorkspace,
  isCurrent: () => boolean
) {
  const state = useAppStore.getState()
  const host = parseExecutionHostId(workspace.executionHostId)
  const worktreePath =
    state.getKnownWorktreeById(workspace.worktreeId, workspace.executionHostId)?.path ??
    workspace.cwd
  const sourceOwner: HttpLinkSourceOwner =
    host?.kind === 'runtime'
      ? { kind: 'runtime', runtimeEnvironmentId: host.environmentId }
      : host?.kind === 'ssh'
        ? { kind: 'ssh', connectionId: host.targetId }
        : host?.kind === 'local'
          ? { kind: 'local' }
          : { kind: 'unknown' }
  return {
    worktreeId: workspace.worktreeId,
    worktreePath,
    startupCwd: workspace.cwd,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null,
    wslDistro:
      host?.kind === 'local'
        ? resolvePaneWslDistro(state, workspace.worktreeId, worktreePath)
        : null,
    sourceOwner,
    isCurrent: () =>
      isCurrent() &&
      getExecutionHostIdForWorktree(useAppStore.getState(), workspace.worktreeId) ===
        workspace.executionHostId,
    getActionDestinations: () => {
      const current = useAppStore.getState()
      const canOpenOwnedBrowser =
        sourceOwner.kind === 'runtime'
          ? canOpenWorkspaceBrowserTabOnRuntime(
              current,
              workspace.worktreeId,
              sourceOwner.runtimeEnvironmentId
            )
          : sourceOwner.kind === 'ssh' &&
            canOpenWorkspaceBrowserTabOnSsh(current, workspace.worktreeId, sourceOwner.connectionId)
      return httpLinkActionDestinationsFor(current.settings, sourceOwner, canOpenOwnedBrowser)
    }
  }
}
