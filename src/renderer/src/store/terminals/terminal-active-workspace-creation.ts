import type { TabSplitTarget } from '../slices/tabs/tabs-slice-contract'
import { createFreshTerminal } from './fresh-terminal-creation'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createActiveWorkspaceTerminalActions(
  _set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'openNewTerminalTabInActiveWorkspace'> {
  return {
    openNewTerminalTabInActiveWorkspace: async (groupId) => {
      const worktreeId = get().activeWorktreeId
      if (worktreeId) {
        await openNewTerminalTabInWorkspace(get, worktreeId, groupId)
      }
    }
  }
}

export async function openNewTerminalTabInWorkspace(
  _get: TerminalStoreGet,
  worktreeId: string,
  groupId?: string,
  split?: TabSplitTarget
): Promise<void> {
  await createFreshTerminal({ worktreeId, groupId, split })
}
