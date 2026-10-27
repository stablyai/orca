import type { AppState } from '../types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { resolveAgentPaneAuthorityKey } from '../slices/agent-pane-authority'
import type { HydrateWorkspaceSessionOptions } from './terminal-contracts'
import { omitUnverifiedPtyLossTabIds } from './terminal-unverified-pty-loss'

export type WorkspaceHydrationPatch = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'repos'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
  | 'lastVisitedAtByWorktreeId'
  | 'defaultTerminalTabsAppliedByWorktreeId'
  | 'closedTerminalTabTombstonesByTabId'
  | 'pairedTerminalTabCloseIntentsByEnvironment'
  | 'automaticAgentResumeClaimsByTabId'
  | 'sleepingAgentSessionsByPaneKey'
  | 'pendingReconnectWorktreeIds'
  | 'pendingReconnectTabByWorktree'
  | 'pendingReconnectPtyIdByTabId'
  | 'everActivatedWorktreeIds'
  | 'unverifiedPtyLossTabIds'
  | 'worktreeNavHistory'
  | 'worktreeNavHistoryIndex'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'localOnlyScrollbackByTabId'
> &
  // Only cold reads carry contested-host shadows; scoped hydration must preserve the store’s copy.
  Partial<
    Pick<
      AppState,
      | 'contestedHostWorkspaceSessions'
      | 'contestedPrimaryHostBySessionKey'
      | 'hydratedRuntimeSessionHostIds'
    >
  >

export function replaceHydratedRecordKeys<T>(
  current: Record<string, T>,
  hydrated: Record<string, T>,
  replaceKeys: ReadonlySet<string>
): Record<string, T> {
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !replaceKeys.has(key))),
    ...Object.fromEntries(Object.entries(hydrated).filter(([key]) => replaceKeys.has(key)))
  }
}

export type TerminalLayoutPtyOwnershipTransfer = {
  removedLeafId: string
  retainedLeafId: string
  ptyId: string
}

export function transferNormalizedTerminalLayoutPtyOwnership(
  state: Pick<AppState, 'terminalLayoutsByTabId' | 'transferAgentPaneAuthority'>,
  tabId: string,
  transfers: readonly TerminalLayoutPtyOwnershipTransfer[]
): void {
  if (transfers.length === 0) {
    return
  }
  const ptyIdsOwnedByOtherTabs = new Set<string>()
  for (const [candidateTabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (candidateTabId === tabId) {
      continue
    }
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      ptyIdsOwnedByOtherTabs.add(ptyId)
    }
  }
  for (const { removedLeafId, retainedLeafId, ptyId } of transfers) {
    if (
      !isTerminalLeafId(removedLeafId) ||
      !isTerminalLeafId(retainedLeafId) ||
      ptyIdsOwnedByOtherTabs.has(ptyId)
    ) {
      continue
    }
    const fromPaneKey = makePaneKey(tabId, removedLeafId)
    const currentOwner = parsePaneKey(resolveAgentPaneAuthorityKey(fromPaneKey))
    if (currentOwner && currentOwner.tabId !== tabId) {
      continue
    }
    state.transferAgentPaneAuthority({
      fromPaneKey,
      toPaneKey: makePaneKey(tabId, retainedLeafId),
      ptyId
    })
  }
}

export function targetScopedWorkspaceHydrationPatch(
  state: AppState,
  hydrated: WorkspaceHydrationPatch,
  session: WorkspaceSessionState,
  options: HydrateWorkspaceSessionOptions
): Partial<AppState> {
  const workspaceKeys = new Set(options.replaceWorkspaceKeys)
  const targetTabIds = new Set(
    [...workspaceKeys].flatMap((workspaceKey) => [
      ...(state.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id),
      ...(session.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
    ])
  )
  const retainedTargetTabIds = new Set(
    [...workspaceKeys].flatMap((workspaceKey) =>
      (hydrated.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
    )
  )
  const deletedTargetTabIds = new Set(
    [...workspaceKeys]
      .flatMap((workspaceKey) => (state.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id))
      .filter((tabId) => !retainedTargetTabIds.has(tabId))
  )
  // Session-scoped PTY-loss reprieve must not protect a retired/replaced row in later orphan sweeps.
  const nextUnverifiedPtyLossTabIds = omitUnverifiedPtyLossTabIds(
    state.unverifiedPtyLossTabIds,
    deletedTargetTabIds
  )
  const pendingReconnectPtyIdByTabId = replaceHydratedRecordKeys(
    state.pendingReconnectPtyIdByTabId,
    {},
    targetTabIds
  )
  const activeOutsideScope =
    state.activeWorktreeId != null && !workspaceKeys.has(state.activeWorktreeId)
  const sleepingAgentSessionsByPaneKey = Object.fromEntries([
    ...Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
      ([, record]) => !workspaceKeys.has(record.worktreeId)
    ),
    ...Object.entries(hydrated.sleepingAgentSessionsByPaneKey).filter(([, record]) =>
      workspaceKeys.has(record.worktreeId)
    )
  ])
  const everActivatedWorktreeIds = new Set(state.everActivatedWorktreeIds)
  for (const workspaceKey of hydrated.everActivatedWorktreeIds) {
    if (workspaceKeys.has(workspaceKey)) {
      everActivatedWorktreeIds.add(workspaceKey)
    }
  }
  return {
    activeRepoId: activeOutsideScope ? state.activeRepoId : hydrated.activeRepoId,
    activeWorktreeId: activeOutsideScope ? state.activeWorktreeId : hydrated.activeWorktreeId,
    activeWorkspaceKey: activeOutsideScope ? state.activeWorkspaceKey : hydrated.activeWorkspaceKey,
    activeWorkspaceExecutionHostId: activeOutsideScope
      ? state.activeWorkspaceExecutionHostId
      : hydrated.activeWorkspaceExecutionHostId,
    activeTabId: activeOutsideScope ? state.activeTabId : hydrated.activeTabId,
    activeTabIdByWorktree: replaceHydratedRecordKeys(
      state.activeTabIdByWorktree,
      hydrated.activeTabIdByWorktree,
      workspaceKeys
    ),
    tabsByWorktree: replaceHydratedRecordKeys(
      state.tabsByWorktree,
      hydrated.tabsByWorktree,
      workspaceKeys
    ),
    lastVisitedAtByWorktreeId: replaceHydratedRecordKeys(
      state.lastVisitedAtByWorktreeId,
      hydrated.lastVisitedAtByWorktreeId,
      workspaceKeys
    ),
    // Why local marks win: the applied mark is write-once.
    defaultTerminalTabsAppliedByWorktreeId: {
      ...replaceHydratedRecordKeys(
        state.defaultTerminalTabsAppliedByWorktreeId,
        hydrated.defaultTerminalTabsAppliedByWorktreeId,
        workspaceKeys
      ),
      ...state.defaultTerminalTabsAppliedByWorktreeId
    },
    // Already fell back to live state; tab-keyed tombstones cannot use workspace-key replacement.
    closedTerminalTabTombstonesByTabId: hydrated.closedTerminalTabTombstonesByTabId,
    pairedTerminalTabCloseIntentsByEnvironment: hydrated.pairedTerminalTabCloseIntentsByEnvironment,
    automaticAgentResumeClaimsByTabId: replaceHydratedRecordKeys(
      state.automaticAgentResumeClaimsByTabId,
      hydrated.automaticAgentResumeClaimsByTabId,
      targetTabIds
    ),
    sleepingAgentSessionsByPaneKey,
    pendingReconnectWorktreeIds: [
      ...state.pendingReconnectWorktreeIds.filter((key) => !workspaceKeys.has(key)),
      ...hydrated.pendingReconnectWorktreeIds.filter((key) => workspaceKeys.has(key))
    ],
    pendingReconnectTabByWorktree: replaceHydratedRecordKeys(
      state.pendingReconnectTabByWorktree,
      hydrated.pendingReconnectTabByWorktree,
      workspaceKeys
    ),
    pendingReconnectPtyIdByTabId,
    everActivatedWorktreeIds,
    ...(nextUnverifiedPtyLossTabIds !== state.unverifiedPtyLossTabIds
      ? { unverifiedPtyLossTabIds: nextUnverifiedPtyLossTabIds }
      : {}),
    ptyIdsByTabId: replaceHydratedRecordKeys(
      state.ptyIdsByTabId,
      hydrated.ptyIdsByTabId,
      targetTabIds
    ),
    terminalLayoutsByTabId: replaceHydratedRecordKeys(
      state.terminalLayoutsByTabId,
      hydrated.terminalLayoutsByTabId,
      targetTabIds
    ),
    localOnlyScrollbackByTabId: replaceHydratedRecordKeys(
      state.localOnlyScrollbackByTabId,
      hydrated.localOnlyScrollbackByTabId,
      targetTabIds
    )
  }
}
