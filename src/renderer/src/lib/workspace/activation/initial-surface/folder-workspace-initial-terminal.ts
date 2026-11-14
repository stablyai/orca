import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { WorktreeSetupLaunch } from '../../../../../../shared/worktree/creation/launch-types'
import type { InitialTerminalOptions } from '@/lib/workspace/activation/worktree-activation-store-contract'
import type { WorktreeStartupPayload } from '@/lib/workspace/creation/worktree-startup-payload'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { useAppStore } from '@/store/index'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'

export function ensureFolderWorkspaceInitialTerminal(
  folderWorkspace: FolderWorkspace,
  startup?: WorktreeStartupPayload,
  providesInitialSurface?: boolean,
  opts?: Pick<
    InitialTerminalOptions,
    'seedUserDefaultSurface' | 'backendStartupTerminalSpawned'
  > & { setup?: WorktreeSetupLaunch }
): string | null {
  if (providesInitialSurface === true && startup === undefined && !opts?.setup) {
    return null
  }
  const state = useAppStore.getState()
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    startup,
    opts?.setup,
    undefined,
    undefined,
    {
      reseedEmptiedWorkspace: providesInitialSurface !== true,
      ...opts
    }
  )
  return primaryTabId
}
