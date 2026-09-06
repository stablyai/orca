import {
  agentStatusAuthorityObservedAt,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-title-owner'
import { isWebTerminalSurfaceTabId, toWebTerminalSurfaceTabId } from '../web-runtime-session'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  MirroredTerminalTab,
  TerminalSurface,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'
import {
  isClientOwnedAgentStatus,
  isFencedClientAgentStatus,
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

/**
 * Stamp this replica's own receipt clock on a row mirrored from another host.
 *
 * The host's `updatedAt` / `evidenceObservedAt` are its wall clock, so decaying a mirrored row
 * against `rendererNow - hostClock` is off by the two machines' skew: a host running fast keeps
 * every remote row permanently fresh, a host running slow decays them on arrival. Both sides of
 * the subtraction have to come from one machine, and the receipt is the only clock the replica
 * owns. See THE DECAY RULE in shared/agent-status-observation.ts.
 *
 * A snapshot that repeats an observation already seen is a repaint, not new evidence, so the
 * first receipt is carried forward — otherwise the window would restart on every publish and
 * a quiet pane would never decay. Only a row this renderer stamped itself is comparable, so
 * the carry-forward requires a previous stamp rather than trusting a cross-machine timestamp.
 */
function withMirroredEvidenceReceipt(
  entry: AgentStatusEntry,
  existing: AgentStatusEntry | undefined,
  now: number
): AgentStatusEntry {
  const receivedAt =
    existing?.mirroredEvidenceReceivedAt !== undefined &&
    agentStatusAuthorityObservedAt(existing) === agentStatusAuthorityObservedAt(entry)
      ? existing.mirroredEvidenceReceivedAt
      : now
  return { ...entry, mirroredEvidenceReceivedAt: receivedAt }
}

export function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
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
    const entry = withMirroredEvidenceReceipt(hostEntry, existing, now)
    // Why: keep fresher OSC state while taking remapped ownership metadata from the authoritative host snapshot.
    const hostIdentityPredatesCurrentTurn =
      existing !== undefined &&
      entry.state === 'done' &&
      existing.state !== 'done' &&
      existing.stateStartedAt > entry.stateStartedAt
    // Why: cross-machine wall clocks are not comparable, so the host frame could
    // outrank live client status forever; a proven client writer keeps its own
    // state (still adopting the host's identity fields below) unless the host
    // carries a state class the client's bytes can never see.
    const clientOwnsEntry =
      isFencedClientAgentStatus(entry.paneKey, existing, now) &&
      !hostAgentStatusPiercesClientAuthority(entry)
    const nextEntry =
      existing && (clientOwnsEntry || existing.updatedAt > entry.updatedAt)
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
            // Why: hook-only content the byte pipeline can never see, and every OSC
            // write blanks it, so a fenced pane's message line stayed empty forever
            // (#12906). Host-first unlike providerSession: only the host can mint one.
            lastAssistantMessage:
              (hostIdentityPredatesCurrentTurn ? undefined : entry.lastAssistantMessage) ??
              existing.lastAssistantMessage,
            lastAssistantMessageIsToolOutput:
              hostIdentityPredatesCurrentTurn || entry.lastAssistantMessage === undefined
                ? existing.lastAssistantMessageIsToolOutput
                : entry.lastAssistantMessageIsToolOutput
          }
        : entry
    nextByPaneKey.set(entry.paneKey, nextEntry)
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of batchAgentPaneKeysForTabs(state, mirroredTabIds, batchContext)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    // Why: the host surface carrying no status is not proof the agent stopped —
    // hook-only hosts publish nothing for OSC-driven panes. Keep a live entry
    // this renderer owns; it decays through the normal freshness boundary.
    // Ownership, not freshness, is the gate here: with no competing host value
    // there is nothing to arbitrate, and a client asleep past the stale
    // boundary would otherwise erase every pane it owns on the first snapshot
    // after wake (STA-3107) instead of decaying it like a local pane.
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
    if (agentStatusEntryEqual(existing, entry)) {
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
    const entrySortRelevantChange =
      !existing ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now) ||
      entryFreshnessChanged ||
      entryAttributionChanged ||
      doneAttentionChanged ||
      isMirroredCommandCodeTurnBump(existing, entry)
    aggregateRelevantChange =
      aggregateRelevantChange || entrySortRelevantChange || workingModeChanged
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
