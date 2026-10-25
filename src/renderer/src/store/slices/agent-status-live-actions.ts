import { resolvePaneKey } from '../../lib/agent-status-pane-ownership'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type {
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-contract'
import {
  resolveAgentPaneAuthorityKey,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'
import {
  buildAgentStatusLiveEntry,
  type AgentStatusLiveEntryBuild,
  type AgentStatusLiveEntryRejection
} from './agent-status-live-entry-builder'
import { reduceAgentStatusLiveUpdate } from './agent-status-live-reducer'
import type { FreshnessLiveEntryDelta } from './agent-status-freshness-scheduler'
import {
  agentStatusTabAlreadyHasProtectedOrGeneratedTitle,
  getTabIdFromPaneKey,
  isRecentlyClosedAgentStatusTab
} from './agent-status-pane-key-tab-binding'
import {
  generatedTitleReplacesExisting,
  generatedTitleSourceText
} from '../../../../shared/agent-generated-tab-title-rules'

export function createAgentStatusLiveActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'setAgentStatus' | 'setAgentStatuses' | 'transactAgentStatuses'> {
  const {
    get,
    set,
    applyGeneratedTabTitleUpdate,
    freshness,
    requestFreshness,
    transactAgentStatuses
  } = runtime
  const setAgentStatus = (
    rawPaneKey: string,
    payload: AgentStatusPayload,
    terminalTitle?: string,
    timing?: AgentStatusTiming,
    routing?: AgentStatusRouting,
    metadata?: AgentStatusMetadata
  ): void => {
    const paneKey = resolveAgentPaneAuthorityKey(rawPaneKey)
    if (metadata?.authorityRestartId && paneKey !== rawPaneKey) {
      return
    }
    const updatedAt = timing?.updatedAt ?? Date.now()
    const current = get()
    if (
      (paneKey in current.recentlyRetiredAgentStatusPaneKeys &&
        (typeof current.recentlyRetiredAgentStatusPaneKeys[paneKey] !== 'string' ||
          current.recentlyRetiredAgentStatusPaneKeys[paneKey] !== metadata?.authorityRestartId)) ||
      isRecentlyClosedAgentStatusTab(
        current.recentlyClosedAgentStatusTabIds,
        getTabIdFromPaneKey(paneKey)
      )
    ) {
      return
    }
    let built: AgentStatusLiveEntryBuild | AgentStatusLiveEntryRejection | null = null
    let liveEntryDelta: FreshnessLiveEntryDelta | null = null
    set((state) => {
      const retirement = state.recentlyRetiredAgentStatusPaneKeys[paneKey]
      if (
        (retirement !== undefined &&
          (typeof retirement !== 'string' || retirement !== metadata?.authorityRestartId)) ||
        isRecentlyClosedAgentStatusTab(
          state.recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        )
      ) {
        return state
      }
      if (retirement !== undefined) {
        const owner = resolvePaneKey(state, paneKey)
        if (
          !owner.exists ||
          payload.agentType !== 'omp' ||
          (routing?.worktreeId !== undefined && routing.worktreeId !== owner.owningWorktreeId) ||
          (routing?.connectionId !== undefined &&
            routing.connectionId !== owner.repoConnectionId &&
            (owner.repoConnectionResolved || routing.worktreeId !== owner.owningWorktreeId))
        ) {
          return state
        }
      }
      built = buildAgentStatusLiveEntry({
        state,
        paneKey,
        payload,
        terminalTitle,
        timing,
        routing,
        metadata,
        updatedAt
      })
      if (!built.entry) {
        return state
      }
      const previousEntries = state.agentStatusByPaneKey
      const reduction = reduceAgentStatusLiveUpdate(state, built, updatedAt)
      liveEntryDelta = {
        previousEntries,
        nextEntries: reduction.patch.agentStatusByPaneKey ?? previousEntries,
        nextEntry: built.entry,
        replacedEntry: previousEntries[built.entry.paneKey],
        evictedEntries: reduction.evictedEntries
      }
      if (retirement !== undefined) {
        // The host confirmed this retired group’s surviving owner; preserve that route for its next retirement.
        for (const [key, id] of Object.entries(state.recentlyRetiredAgentStatusPaneKeys)) {
          if (id === retirement && key !== paneKey && resolveAgentPaneAuthorityKey(key) === key) {
            transferAgentPaneAuthorityAlias({ fromPaneKey: key, toPaneKey: paneKey })
          }
        }
        const nextRetired = { ...state.recentlyRetiredAgentStatusPaneKeys }
        delete nextRetired[paneKey]
        return { ...reduction.patch, recentlyRetiredAgentStatusPaneKeys: nextRetired }
      }
      return reduction.patch
    })
    if (liveEntryDelta) {
      freshness.noteLiveEntryDelta(liveEntryDelta)
    }
    // Zustand's updater runs synchronously, but TypeScript cannot observe the closure assignment.
    const builtResult = built as AgentStatusLiveEntryBuild | AgentStatusLiveEntryRejection | null
    if (!builtResult?.entry) {
      // Rejected stale standalone events retain deferred scan contract; suppressed inherited-terminal frames must skip O(entries) work.
      if (builtResult?.reason !== 'suppressed-inherited-terminal') {
        requestFreshness(false)
      }
      return
    }
    const { entry } = builtResult
    const shouldReplaceGeneratedTitle = generatedTitleReplacesExisting(entry)
    const mayWriteGeneratedTitle =
      get().settings?.tabAutoGenerateTitle === true &&
      (shouldReplaceGeneratedTitle ||
        !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
          get(),
          entry.tabId ?? getTabIdFromPaneKey(paneKey),
          entry.worktreeId
        ))
    const generatedTitlePrompt = mayWriteGeneratedTitle
      ? generatedTitleSourceText(entry)
      : entry.prompt
    applyGeneratedTabTitleUpdate({
      paneKey,
      prompt: generatedTitlePrompt,
      ...(shouldReplaceGeneratedTitle ? { options: { replaceExistingGeneratedTitle: true } } : {})
    })
    requestFreshness(true)
    if (builtResult.completionRefreshWorktreeId) {
      const worktreeId = builtResult.completionRefreshWorktreeId
      queueMicrotask(() => get().refreshGitHubForWorktreeIfStale(worktreeId))
    }
  }

  const setAgentStatuses = (updates: Parameters<AgentStatusSlice['setAgentStatuses']>[0]) =>
    updates.length === 0
      ? []
      : transactAgentStatuses((transaction) => updates.map(transaction.apply))

  return { setAgentStatus, setAgentStatuses, transactAgentStatuses }
}
