import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/types'
import type {
  DirectSshLivePtyBinding,
  DirectSshPaneRetryResult,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'

export function directSshAuthoritiesEqual(
  left: DirectSshAuthority,
  right: DirectSshAuthority
): boolean {
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

export function withoutTabIds<T>(
  source: Record<string, T>,
  tabIds: ReadonlySet<string>
): Record<string, T> {
  let next = source
  for (const tabId of tabIds) {
    if (!(tabId in next)) {
      continue
    }
    if (next === source) {
      next = { ...source }
    }
    delete next[tabId]
  }
  return next
}

export function pruneObsoleteAuthorityState(
  state: DirectSshTerminalBindingState,
  authority: DirectSshAuthority
): Pick<
  DirectSshTerminalBindingState,
  | 'directSshPaneRetryByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'directSshPaneRetryHistoryByTabId'
> {
  const prune = <T extends { authority: DirectSshAuthority }>(
    source: Record<string, T>
  ): Record<string, T> => {
    const obsoleteIds = Object.entries(source)
      .filter(
        ([, value]) =>
          value.authority.targetId === authority.targetId &&
          !directSshAuthoritiesEqual(value.authority, authority)
      )
      .map(([tabId]) => tabId)
    return withoutTabIds(source, new Set(obsoleteIds))
  }
  return {
    directSshPaneRetryByTabId: prune(state.directSshPaneRetryByTabId),
    directSshLivePtyBindingByTabId: prune(state.directSshLivePtyBindingByTabId),
    directSshPaneRetryHistoryByTabId: prune(state.directSshPaneRetryHistoryByTabId)
  }
}

export function liveBindingMatches(
  tab: TerminalTab,
  binding: DirectSshLivePtyBinding | undefined,
  authority: DirectSshAuthority
): boolean {
  return Boolean(
    binding &&
    directSshAuthoritiesEqual(binding.authority, authority) &&
    binding.tabGeneration === (tab.generation ?? 0) &&
    (binding.ptyId === tab.ptyId || (tab.ptyId == null && Boolean(tab.pendingActivationSpawn)))
  )
}

export function settleDirectSshPaneRetryState(
  state: DirectSshTerminalBindingState,
  result: DirectSshPaneRetryResult
): Partial<DirectSshTerminalBindingState> | null {
  const pending = state.directSshPaneRetryByTabId[result.tabId]
  const live = state.directSshLivePtyBindingByTabId[result.tabId]
  const pendingMatches = Boolean(
    pending &&
    pending.attemptId === result.attemptId &&
    directSshAuthoritiesEqual(pending.authority, result.authority) &&
    pending.tabGeneration === result.tabGeneration
  )
  const liveMatches = Boolean(
    live &&
    live.attemptId === result.attemptId &&
    directSshAuthoritiesEqual(live.authority, result.authority) &&
    live.tabGeneration === result.tabGeneration
  )
  if (!pendingMatches && !liveMatches) {
    return null
  }
  const tabIds = new Set([result.tabId])
  const nextPending = pendingMatches
    ? withoutTabIds(state.directSshPaneRetryByTabId, tabIds)
    : state.directSshPaneRetryByTabId
  if (result.status !== 'success') {
    return {
      directSshPaneRetryByTabId: nextPending,
      directSshLivePtyBindingByTabId: liveMatches
        ? withoutTabIds(state.directSshLivePtyBindingByTabId, tabIds)
        : state.directSshLivePtyBindingByTabId
    }
  }
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === result.tabId)
  if (
    !tab ||
    (tab.generation ?? 0) !== result.tabGeneration ||
    !tab.ptyId ||
    !(state.ptyIdsByTabId[result.tabId] ?? []).includes(result.ptyId)
  ) {
    return null
  }
  return {
    directSshPaneRetryByTabId: nextPending,
    directSshLivePtyBindingByTabId: {
      ...state.directSshLivePtyBindingByTabId,
      [result.tabId]: {
        attemptId: result.attemptId,
        authority: result.authority,
        tabGeneration: result.tabGeneration,
        ptyId: liveMatches && live ? live.ptyId : tab.ptyId
      }
    }
  }
}

export function transferDirectSshPaneDetachLedger(
  state: DirectSshTerminalBindingState,
  args: {
    detachedPtyId: string | null
    sourcePtyId: string | null
    sourceTabId: string
    targetTabId: string
    isAuthorityCurrent: (authority: DirectSshAuthority) => boolean
  }
): Pick<
  DirectSshTerminalBindingState,
  | 'directSshPaneRetryByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'directSshPaneRetryHistoryByTabId'
> {
  const tabIds = new Set([args.sourceTabId, args.targetTabId])
  let directSshPaneRetryByTabId = withoutTabIds(state.directSshPaneRetryByTabId, tabIds)
  let directSshLivePtyBindingByTabId = withoutTabIds(state.directSshLivePtyBindingByTabId, tabIds)
  let directSshPaneRetryHistoryByTabId = withoutTabIds(
    state.directSshPaneRetryHistoryByTabId,
    tabIds
  )
  const tabs = Object.values(state.tabsByWorktree).flat()
  const sourceTab = tabs.find((tab) => tab.id === args.sourceTabId)
  const targetTab = tabs.find((tab) => tab.id === args.targetTabId)
  const live = state.directSshLivePtyBindingByTabId[args.sourceTabId]
  const pending = state.directSshPaneRetryByTabId[args.sourceTabId]
  const sourceHasPendingContinuation = Boolean(
    sourceTab && !args.sourcePtyId && sourceTab.pendingActivationSpawn
  )
  const targetHasPendingContinuation = Boolean(
    targetTab && !args.detachedPtyId && targetTab.pendingActivationSpawn
  )
  const hasEmptyPendingContinuation = Boolean(
    pending &&
    sourceHasPendingContinuation &&
    targetHasPendingContinuation &&
    pending.tabGeneration === (sourceTab?.generation ?? 0) &&
    args.isAuthorityCurrent(pending.authority)
  )
  const liveLease =
    live && sourceTab && liveBindingMatches(sourceTab, live, live.authority) ? live : null
  const pendingLease =
    pending &&
    sourceTab &&
    pending.tabGeneration === (sourceTab.generation ?? 0) &&
    ([args.detachedPtyId, args.sourcePtyId].some(
      (ptyId) => parseAppSshPtyId(ptyId ?? '')?.connectionId === pending.authority.targetId
    ) ||
      hasEmptyPendingContinuation)
      ? pending
      : null
  const sourceLease = liveLease ?? pendingLease
  const authority = sourceLease?.authority
  if (
    sourceLease &&
    authority &&
    targetTab &&
    (args.detachedPtyId || targetHasPendingContinuation) &&
    args.isAuthorityCurrent(authority)
  ) {
    const nextLiveBindings = { ...directSshLivePtyBindingByTabId }
    if (
      sourceTab &&
      ((args.sourcePtyId &&
        parseAppSshPtyId(args.sourcePtyId)?.connectionId === authority.targetId) ||
        sourceHasPendingContinuation)
    ) {
      if (liveLease) {
        nextLiveBindings[args.sourceTabId] = {
          attemptId: sourceLease.attemptId,
          authority,
          tabGeneration: sourceTab.generation ?? 0,
          ptyId: args.sourcePtyId ?? liveLease.ptyId
        }
      } else if (pendingLease) {
        directSshPaneRetryByTabId = {
          ...directSshPaneRetryByTabId,
          [args.sourceTabId]: pendingLease
        }
      }
    }
    if (args.detachedPtyId || liveLease) {
      nextLiveBindings[args.targetTabId] = {
        attemptId: sourceLease.attemptId,
        authority,
        tabGeneration: targetTab.generation ?? 0,
        ptyId: args.detachedPtyId ?? liveLease!.ptyId
      }
    } else if (pendingLease) {
      directSshPaneRetryByTabId = {
        ...directSshPaneRetryByTabId,
        [args.targetTabId]: {
          ...pendingLease,
          tabGeneration: targetTab.generation ?? 0
        }
      }
    }
    directSshLivePtyBindingByTabId = nextLiveBindings
    const history = state.directSshPaneRetryHistoryByTabId[args.sourceTabId]
    if (history && directSshAuthoritiesEqual(history.authority, authority)) {
      directSshPaneRetryHistoryByTabId = {
        ...directSshPaneRetryHistoryByTabId,
        ...(args.sourcePtyId || sourceHasPendingContinuation
          ? { [args.sourceTabId]: history }
          : {}),
        [args.targetTabId]: history
      }
    }
  }
  return {
    directSshPaneRetryByTabId,
    directSshLivePtyBindingByTabId,
    directSshPaneRetryHistoryByTabId
  }
}
