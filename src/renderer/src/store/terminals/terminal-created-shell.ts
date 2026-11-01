import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getProjectRuntimeFolder } from '@/lib/local-project-runtime-workspace'
import { findLocalFolderWorkspaceRuntimeRepo } from '../../../../shared/folder-workspace-execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  getRemoteConnectionIdForWorktree,
  resolveCreatedTabShellOverride,
  worktreeUsesWslPath
} from './terminal-workspace-routing'
import type { AppState } from '../types'
import type { TerminalActions } from './terminal-actions'
import type { TerminalCreationExecutionFacts } from './terminal-contracts'

export function resolveTerminalCreatedShell(
  s: AppState,
  worktreeId: string,
  shellOverride: string | undefined,
  options: Parameters<TerminalActions['createTab']>[3],
  facts: TerminalCreationExecutionFacts | undefined
) {
  const folder = getProjectRuntimeFolder(s, worktreeId, facts?.hostId)
  const selectedFolder = folder
    ? {
        ...folder.workspace,
        executionHostId: folder.hostId,
        connectionId: folder.connectionId
      }
    : undefined
  const runtimeRepo =
    selectedFolder && findLocalFolderWorkspaceRuntimeRepo(s, selectedFolder.id, selectedFolder)
  const runtimeWorktree =
    selectedFolder && runtimeRepo
      ? { ...folderWorkspaceToWorktree(selectedFolder), repoId: runtimeRepo.id }
      : undefined
  const remoteConnectionId = facts
    ? facts.connectionId
    : folder
      ? folder.connectionId
      : getRemoteConnectionIdForWorktree(s, worktreeId)
  const isRemoteWorktree = facts?.isRemote ?? Boolean(remoteConnectionId)
  const isWslWorktree =
    facts?.isWsl ??
    (folder ? isWslUncPath(folder.workspace.folderPath) : worktreeUsesWslPath(s, worktreeId))
  const createdShellOverride = resolveCreatedTabShellOverride(
    shellOverride,
    s.settings?.terminalWindowsShell,
    // Why: SSH PTYs ignore local Windows shell selection; a local shell icon would mislabel a remote terminal.
    isRemoteWorktree,
    facts
      ? facts.platform
      : remoteConnectionId
        ? ((s.sshConnectionStates.get(remoteConnectionId)
            ?.remotePlatform as NodeJS.Platform | null) ?? null)
        : null,
    // Why: new terminals enter the worktree's repo-scoped WSL distro even when the global Windows shell is PowerShell/cmd.exe.
    isWslWorktree,
    facts
      ? facts.projectRuntime
      : isRemoteWorktree || options?.forceHostRuntime
        ? undefined
        : getLocalProjectExecutionRuntimeContext(
            s,
            worktreeId,
            undefined,
            {},
            runtimeWorktree && runtimeRepo
              ? { worktree: runtimeWorktree, repo: runtimeRepo }
              : undefined
          )
  )
  return { folder, createdShellOverride }
}
