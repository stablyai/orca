import { resolveAgentSessionStartedAt } from '../../../../shared/agent-session-start-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { withMirroredEvidenceReceipt } from '../../../../shared/agent-status-freshness'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-title-owner'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  MirroredTerminalTab,
  TerminalSurface,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'
import {
  isClientOwnedAgentStatus,
  isMirroredAgentStatusOwnedBy,
  clientAgentStatusFencesHost,
  hostAgentStatusPiercesClientAuthority,
  isMirroredAgentPaneKeyForTabs,
  batchAgentPaneKeysForTabs,
  remapHostAgentStatus,
  updateBatchAgentPaneKey
} from './agent-status-primitives'
import {
  agentStatusEntryEqual,
  isAgentStatusFresh,
  isMirroredCommandCodeTurnBump,
  writableWebSessionTabsRecord
} from './state-equality-core'

export function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
  environmentId: string,
  worktreeId: string,
  retractedTabIds: ReadonlySet<string>,
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Pick<WebSessionTabsSyncState, 'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'> | null {
  const mirroredTabIds = new Set<string>()
  for (const tab of currentTerminalTabs) {
    if (isWebTerminalSurfaceTabId(tab.id)) {
      mirroredTabIds.add(tab.id)
    }
  }
  for (const surface of terminalSurfaceTabs) {
    mirroredTabIds.add(toWebTerminalSurfaceTabId(surface.parentTabId))
  }

  if (mirroredTabIds.size === 0) {
    return null
  }

  let retainedSurfaceByHostTabAndPrunedLeafId:
    | Map<string, ReadonlyMap<string, TerminalSurface>>
    | undefined
  for (const entry of mirroredTerminalTabs) {
    if (entry.retainedSurfaceByPrunedLeafId) {
      retainedSurfaceByHostTabAndPrunedLeafId ??= new Map()
      retainedSurfaceByHostTabAndPrunedLeafId.set(
        entry.hostTabId,
        entry.retainedSurfaceByPrunedLeafId
      )
    }
  }
  const nextByPaneKey = new Map<string, AgentStatusEntry>()
  for (const surface of terminalSurfaceTabs) {
    const retainedSurface = retainedSurfaceByHostTabAndPrunedLeafId
      ?.get(surface.parentTabId)
      ?.get(surface.leafId)
    const hostEntry = remapHostAgentStatus(surface, retainedSurface)
    if (!hostEntry) {
      continue
    }
    const existing =
      nextByPaneKey.get(hostEntry.paneKey) ?? state.agentStatusByPaneKey[hostEntry.paneKey]
    const entry = withMirroredEvidenceReceipt(
      hostEntry.connectionId === undefined
        ? { ...hostEntry, connectionId: environmentId }
        : hostEntry,
      existing,
      now
    )
    // Retain fresher OSC state while remapping authoritative host identity.
    const hostIdentityPredatesCurrentTurn =
      existing !== undefined &&
      entry.state === 'done' &&
      existing.state !== 'done' &&
      existing.stateStartedAt > entry.stateStartedAt
    // Cross-machine clocks cannot arbitrate live byte ownership; keep client state except host-only classes, adopting host identity below.
    const hostPiercesAuthority = hostAgentStatusPiercesClientAuthority(entry)
    const clientOwnsEntry = clientAgentStatusFencesHost(entry.paneKey, existing, entry, now)
    const nextEntry =
      existing &&
      (clientOwnsEntry ||
        (!hostPiercesAuthority &&
          isAgentStatusFresh(existing, now) &&
          existing.updatedAt > entry.updatedAt))
        ? {
            ...normalizeCompatibleAgentStatusEntryForOwner(existing, entry.agentType),
            ...(clientOwnsEntry && existing.state === 'working' && entry.state === 'working'
              ? { workingMode: entry.workingMode }
              : {}),
            paneKey: entry.paneKey,
            worktreeId: entry.worktreeId ?? existing.worktreeId,
            tabId: entry.tabId,
            providerSession:
              existing.providerSession ??
              (hostIdentityPredatesCurrentTurn ? undefined : entry.providerSession),
            // Only hooks mint message content and OSC blanks it; take host-first even behind the client fence (#12906), unlike providerSession.
            lastAssistantMessage:
              (hostIdentityPredatesCurrentTurn ? undefined : entry.lastAssistantMessage) ??
              existing.lastAssistantMessage,
            lastAssistantMessageIsToolOutput:
              hostIdentityPredatesCurrentTurn || entry.lastAssistantMessage === undefined
                ? existing.lastAssistantMessageIsToolOutput
                : entry.lastAssistantMessageIsToolOutput
          }
        : entry
    const accepted =
      nextEntry === entry ? entry : withHostProgramStatus(nextEntry, entry.programStatus)
    const retained = existing ? undefined : state.retainedAgentsByPaneKey?.[entry.paneKey]
    nextByPaneKey.set(entry.paneKey, {
      ...accepted,
      firstStateStartedAt: resolveAgentSessionStartedAt({
        entry: accepted,
        previous: existing ?? retained?.entry,
        previousStartedAt: retained?.startedAt
      })
    })
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of batchAgentPaneKeysForTabs(state, mirroredTabIds, batchContext)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (
      !isMirroredAgentStatusOwnedBy(state.agentStatusByPaneKey[paneKey], environmentId, worktreeId)
    ) {
      continue
    }
    // The retirement sweep must see the live row to suppress ghost retention.
    if (isMirroredAgentPaneKeyForTabs(paneKey, retractedTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    // Host omission cannot prove OSC-driven exit. Retain owned rows through staleness so wake decays them like local panes instead of erasing them (STA-3107).
    if (isClientOwnedAgentStatus(paneKey, state.agentStatusByPaneKey[paneKey])) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    delete nextAgentStatusByPaneKey[paneKey]
    updateBatchAgentPaneKey(paneKey, false, batchContext)
    changed = true
    aggregateRelevantChange = true
    sortRelevantChange = true
  }

  for (const [paneKey, entry] of nextByPaneKey) {
    const existing = nextAgentStatusByPaneKey[paneKey]
    if (
      agentStatusEntryEqual(existing, entry) &&
      existing?.firstStateStartedAt === entry.firstStateStartedAt
    ) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    nextAgentStatusByPaneKey[paneKey] = entry
    updateBatchAgentPaneKey(paneKey, true, batchContext)
    changed = true
    const entryAttributionChanged =
      existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
    const entryFreshnessChanged =
      !!existing && isAgentStatusFresh(existing, now) !== isAgentStatusFresh(entry, now)
    const doneAttentionChanged =
      existing?.state === 'done' &&
      entry.state === 'done' &&
      agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
    const workingModeChanged = existing?.workingMode !== entry.workingMode
    // A verdict moves no clock, including a main agent failing while its subagents keep the row working.
    const verdictChanged =
      !!existing && agentMainAgentVerdict(existing) !== agentMainAgentVerdict(entry)
    const entrySortRelevantChange =
      !existing ||
      existing.firstStateStartedAt !== entry.firstStateStartedAt ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now) ||
      entryFreshnessChanged ||
      entryAttributionChanged ||
      doneAttentionChanged ||
      isMirroredCommandCodeTurnBump(existing, entry)
    aggregateRelevantChange =
      aggregateRelevantChange || entrySortRelevantChange || workingModeChanged || verdictChanged
    sortRelevantChange = sortRelevantChange || entrySortRelevantChange
  }

  if (!changed) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: aggregateRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch
  }
}

// Why host-only: client OSC writes have no facet channel, so the host's facet is the current one.
function withHostProgramStatus(
  entry: AgentStatusEntry,
  programStatus: AgentStatusEntry['programStatus']
): AgentStatusEntry {
  const { programStatus: _clientFacet, ...rest } = entry
  return programStatus ? { ...rest, programStatus } : rest
}
