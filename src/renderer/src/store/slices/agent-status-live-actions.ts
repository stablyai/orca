import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type {
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-contract'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'
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
  getAgentRowGeneratedTitleText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'

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
    const updatedAt = timing?.updatedAt ?? Date.now()
    const current = get()
    if (
      paneKey in current.recentlyRetiredAgentStatusPaneKeys ||
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
      return reduction.patch
    })
    if (liveEntryDelta) {
      freshness.noteLiveEntryDelta(liveEntryDelta)
    }
    // Zustand's updater runs synchronously, but TypeScript cannot observe the closure assignment.
    const builtResult = built as AgentStatusLiveEntryBuild | AgentStatusLiveEntryRejection | null
    if (!builtResult?.entry) {
      // Keep standalone calls' deferred freshness contract when a stale event is rejected, but a
      // suppressed inherited-terminal frame returns without buying the deferred O(entries) scan.
      if (builtResult?.reason !== 'suppressed-inherited-terminal') {
        requestFreshness(false)
      }
      return
    }
    const { entry } = builtResult
    // Sticky orchestration titles are replaced only when they still describe this dispatch.
    const hasMatchingOrchestrationLabels = Boolean(
      (entry.orchestration?.displayName?.trim() || entry.orchestration?.taskTitle?.trim()) &&
      orchestrationLabelsMatchLiveDispatch(entry)
    )
    const liveIsDispatchPrompt = isOrcaDispatchPrompt(entry.prompt)
    const liveDispatchTaskId = liveIsDispatchPrompt ? getOrcaDispatchTaskId(entry.prompt) : null
    const stickyOrchestrationTaskId = entry.orchestration?.taskId?.trim() || null
    const isNewDispatchAgainstStickyOrchestration = Boolean(
      liveDispatchTaskId &&
      stickyOrchestrationTaskId &&
      liveDispatchTaskId !== stickyOrchestrationTaskId
    )
    const shouldReplaceGeneratedTitle =
      hasMatchingOrchestrationLabels || isNewDispatchAgainstStickyOrchestration
    const mayWriteGeneratedTitle =
      get().settings?.tabAutoGenerateTitle === true &&
      (shouldReplaceGeneratedTitle ||
        !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
          get(),
          entry.tabId ?? getTabIdFromPaneKey(paneKey),
          entry.worktreeId
        ))
    const generatedTitlePrompt =
      liveIsDispatchPrompt && mayWriteGeneratedTitle
        ? getAgentRowGeneratedTitleText(entry)
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
