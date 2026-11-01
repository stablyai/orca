import { parseExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { selectKnownWorktreeById } from '@/store/selectors'
import type { AppState } from '../../store/types'
import { isWorktreeOwnHost } from './tab-bar-host-terminal-targets'

export function selectTerminalTabHostBadgeLabel(
  state: AppState,
  worktreeId: string,
  unifiedTabId: string
): string | null {
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === unifiedTabId)
  const worktree = selectKnownWorktreeById(state, worktreeId)
  if (!tab?.executionHostId || !worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  if (isWorktreeOwnHost(tab.executionHostId, worktree, repo)) {
    return null
  }
  const label = selectExecutionHostDisplayLabel(state, tab.executionHostId)
  const alias = tab.hostTerminalAlias
  if (!alias) {
    return label
  }
  const host = parseExecutionHostId(alias.executionHostId)
  const entry =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const gone = state.tabsByWorktree[worktreeId]?.find(
    (row) => row.id === tab.entityId
  )?.hostTerminalAliasGone
  const status = isDisconnectedRuntimeHostState(runtimeHostConnectionStateForEntry(entry))
    ? translate('auto.components.settings.RepositoryPane.hostStateDisconnected', 'Disconnected')
    : gone
      ? translate(
          'auto.components.terminal.pane.TerminalErrorToast.remoteTerminalClosed',
          'Remote terminal was closed.'
        )
      : null
  return status ? `${label ?? ''} · ${status}` : label
}
