import type { TerminalTab } from '../../../../shared/types'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import {
  createWebSessionTerminalParkAuthorityRevisionScopeKey,
  useWebSessionTerminalParkAuthorityRevisionKey
} from '@/runtime/web-session-terminal-park-authority'
import { useAppStore } from '@/store'
import {
  getTerminalParkWorktreeOwner,
  type TerminalParkWorktreeOwnerState
} from './terminal-park-worktree-owner'
import type { TerminalParkWorktreeOwner } from './terminal-park-pty-restore-eligibility'

type TerminalParkAuthorityState = TerminalParkWorktreeOwnerState & {
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>
}

type AuthorityTab = Pick<TerminalTab, 'id' | 'ptyId'>

export function selectTerminalParkAuthorityEnvironmentKey(
  state: Pick<TerminalParkAuthorityState, 'terminalLayoutsByTabId'>,
  tabs: readonly AuthorityTab[],
  worktreeOwner: TerminalParkWorktreeOwner
): string {
  if (worktreeOwner.kind !== 'local') {
    return ''
  }
  const environmentIds = new Set<string>()
  const addPty = (ptyId: string | null | undefined): void => {
    const environmentId = ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
    if (environmentId) {
      environmentIds.add(environmentId)
    }
  }
  for (const tab of tabs) {
    addPty(tab.ptyId)
    for (const ptyId of Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})) {
      addPty(ptyId)
    }
  }
  return Array.from(environmentIds).sort().join('\u0000')
}

export function selectTerminalWorktreeParkAuthorityRevisionScopeKey(
  state: TerminalParkAuthorityState,
  worktreeIds: readonly string[],
  tabsByWorktree: Readonly<Record<string, readonly AuthorityTab[] | undefined>>
): string {
  const scope = Array.from(new Set(worktreeIds))
    .sort()
    .map((worktreeId) => {
      const environmentKey = selectTerminalParkAuthorityEnvironmentKey(
        state,
        tabsByWorktree[worktreeId] ?? [],
        getTerminalParkWorktreeOwner(state, worktreeId)
      )
      return [worktreeId, environmentKey ? environmentKey.split('\u0000') : []] as const
    })
  return createWebSessionTerminalParkAuthorityRevisionScopeKey(scope)
}

export function useTerminalParkAuthorityRevisionKey(
  worktreeId: string,
  tabs: readonly AuthorityTab[],
  worktreeOwner: TerminalParkWorktreeOwner
): string {
  const environmentKey = useAppStore((state) =>
    selectTerminalParkAuthorityEnvironmentKey(state, tabs, worktreeOwner)
  )
  return useWebSessionTerminalParkAuthorityRevisionKey(worktreeId, environmentKey)
}
