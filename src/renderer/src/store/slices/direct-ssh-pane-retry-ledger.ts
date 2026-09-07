import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { shouldRetryPaneSpawnOnSshReconnect } from '../../hooks/ssh-reconnect-pane-retry'
import {
  directSshAuthoritiesEqual,
  liveBindingMatches,
  pruneObsoleteAuthorityState
} from './direct-ssh-terminal-authority-ledger'
import { invalidateStaleDirectSshTerminalBindings } from './direct-ssh-terminal-recovery'
import { getTerminalActivationSpawnSuppression } from './terminal-activation-spawn-suppression'
import type {
  DirectSshPaneRetryAttemptId,
  DirectSshTerminalBindingState,
  DirectSshTerminalRetryResult
} from './direct-ssh-terminal-recovery-types'

const AUTOMATIC_RETRY_LIMIT = 2

type DirectSshTerminalRetryOptions = {
  qualifiedTabIds?: ReadonlySet<string>
}

function createAttemptId(
  authority: DirectSshAuthority,
  tabId: string,
  tabGeneration: number,
  now: number
): DirectSshPaneRetryAttemptId {
  return JSON.stringify([
    authority.targetId,
    authority.providerEpoch,
    authority.connectionGeneration,
    tabId,
    tabGeneration,
    now
  ]) as DirectSshPaneRetryAttemptId
}

export function retryDirectSshTerminalPanes(
  state: DirectSshTerminalBindingState & {
    deferredSshSessionIdsByTabId: Record<string, string>
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
    disownedPtyIds?: Record<string, true>
  },
  terminalWorkspaceKeys: ReadonlySet<string>,
  authority: DirectSshAuthority,
  now: number,
  options: DirectSshTerminalRetryOptions = {}
): DirectSshTerminalRetryResult {
  const authorityState = pruneObsoleteAuthorityState(state, authority)
  const invalidated = invalidateStaleDirectSshTerminalBindings(
    { ...state, ...authorityState },
    terminalWorkspaceKeys,
    authority,
    options.qualifiedTabIds
  )
  const working = { ...state, ...authorityState, ...invalidated.patch }
  let tabsByWorktree = working.tabsByWorktree
  let pending = working.directSshPaneRetryByTabId
  let history = working.directSshPaneRetryHistoryByTabId
  let retriedCount = 0

  for (const workspaceKey of terminalWorkspaceKeys) {
    const tabs = working.tabsByWorktree[workspaceKey] ?? []
    let nextTabs = tabs
    for (const [index, tab] of tabs.entries()) {
      if (options.qualifiedTabIds && !options.qualifiedTabIds.has(tab.id)) {
        continue
      }
      const currentPending = pending[tab.id]
      if (
        currentPending &&
        directSshAuthoritiesEqual(currentPending.authority, authority) &&
        currentPending.tabGeneration === (tab.generation ?? 0)
      ) {
        continue
      }
      if (
        liveBindingMatches(tab, working.directSshLivePtyBindingByTabId[tab.id], authority) ||
        // Why `working` and not `state`: invalidateStaleDirectSshTerminalBindings has already
        // dropped the bindings it judged stale for this authority, so a retry is not blocked by a
        // record that step just retired.
        !shouldRetryPaneSpawnOnSshReconnect({
          targetId: authority.targetId,
          tabPtyId: tab.ptyId,
          tabPtyIds: working.ptyIdsByTabId?.[tab.id],
          leafPtyIds: Object.values(working.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}),
          disownedPtyIds: working.disownedPtyIds,
          deferredSessionId: state.deferredSshSessionIdsByTabId[tab.id]
        })
      ) {
        continue
      }
      const previousHistory = history[tab.id]
      const sameAuthorityAttempts =
        previousHistory && directSshAuthoritiesEqual(previousHistory.authority, authority)
          ? previousHistory.attemptedAt
          : []
      // Why: a 31s PTY timeout outlives the old rolling window; authority rotation is the reset boundary for this automatic chain.
      const recentAttempts = sameAuthorityAttempts
      if (recentAttempts.length >= AUTOMATIC_RETRY_LIMIT) {
        continue
      }
      const tabGeneration = (tab.generation ?? 0) + 1
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      nextTabs[index] = {
        ...tab,
        generation: tabGeneration,
        pendingActivationSpawn: getTerminalActivationSpawnSuppression(
          state.terminalLayoutsByTabId?.[tab.id]
        )
      }
      if (pending === working.directSshPaneRetryByTabId) {
        pending = { ...working.directSshPaneRetryByTabId }
      }
      pending[tab.id] = {
        attemptId: createAttemptId(authority, tab.id, tabGeneration, now),
        authority,
        tabGeneration,
        startedAt: now
      }
      if (history === working.directSshPaneRetryHistoryByTabId) {
        history = { ...working.directSshPaneRetryHistoryByTabId }
      }
      history[tab.id] = { authority, attemptedAt: [...recentAttempts, now] }
      retriedCount += 1
    }
    if (nextTabs !== tabs) {
      if (tabsByWorktree === working.tabsByWorktree) {
        tabsByWorktree = { ...working.tabsByWorktree }
      }
      tabsByWorktree[workspaceKey] = nextTabs
    }
  }

  const recoveryChanged =
    Object.keys(authorityState).some(
      (key) =>
        authorityState[key as keyof typeof authorityState] !==
        state[key as keyof typeof authorityState]
    ) || invalidated.patch != null
  if (retriedCount === 0 && !recoveryChanged) {
    return { retriedCount, patch: null }
  }
  return {
    retriedCount,
    patch: {
      ...authorityState,
      ...invalidated.patch,
      tabsByWorktree,
      directSshPaneRetryByTabId: pending,
      directSshPaneRetryHistoryByTabId: history
    }
  }
}

export function retrySettledDirectSshTerminalPane(
  state: DirectSshTerminalBindingState & {
    deferredSshSessionIdsByTabId: Record<string, string>
    disownedPtyIds?: Record<string, true>
  },
  terminalWorkspaceKeys: ReadonlySet<string>,
  authority: DirectSshAuthority,
  tabId: string,
  now: number
): DirectSshTerminalRetryResult {
  return retryDirectSshTerminalPanes(state, terminalWorkspaceKeys, authority, now, {
    qualifiedTabIds: new Set([tabId])
  })
}
