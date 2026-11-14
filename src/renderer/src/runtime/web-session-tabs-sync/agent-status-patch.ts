import { recordDraft } from '@/store/keyed-record-transitions'
import { conversationSessionStartedAt } from '../../store/slices/agent-status/agent-conversation-acceptance'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  classifyAgentPaneConversation,
  projectAgentPaneConversation
} from '../../store/slices/agent-status/agent-pane-conversation'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { withMirroredEvidenceReceipt } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { agentEntryCompletionAt } from '../../../../shared/agent-status/lifecycle/agent-completion-time'
import { agentMainAgentVerdict } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-status/title/agent-title-owner'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/workspace-layout/terminal-surface-id'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type {
  MirroredTerminalTab,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import {
  isClientOwnedAgentStatus,
  isMirroredAgentStatusOwnedBy,
  clientAgentStatusFencesHost,
  hostAgentStatusPiercesClientAuthority,
  isMirroredAgentPaneKeyForTabs,
  agentPaneKeysForTabs,
  remapHostAgentStatus
} from './agent-status-primitives'
import {
  retirePaneLaunchNote,
  retiresLaunch
} from '../../store/slices/agent-status/agent-status-launch-config'
import {
  agentStatusEntryEqual,
  isAgentStatusFresh,
  isMirroredCommandCodeTurnBump
} from './state-equality-core'

type MirroredAgentStatusPatch = Pick<
  WebSessionTabsSyncState,
  'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'
> &
  Partial<
    Pick<
      WebSessionTabsSyncState,
      | 'agentLaunchConfigByPaneKey'
      | 'sleepingAgentSessionsByPaneKey'
      | 'agentConversationsByPaneKey'
    >
  >

export function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly RuntimeMobileSessionTerminalClientTab[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
  environmentId: string,
  worktreeId: string,
  retractedTabIds: ReadonlySet<string>,
  now: number,
  batchContext?: WebSessionTabsBatchContext
): MirroredAgentStatusPatch | null {
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

  const survivingSleepingPaneKeys = new Set(
    terminalSurfaceTabs.map(
      (surface) => `${toWebTerminalSurfaceTabId(surface.parentTabId)}:${surface.leafId}`
    )
  )
  let retainedSurfaceByHostTabAndPrunedLeafId:
    | Map<string, ReadonlyMap<string, RuntimeMobileSessionTerminalClientTab>>
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
    const hostEntry = remapHostAgentStatus(surface, worktreeId, retainedSurface)
    if (!hostEntry) {
      continue
    }
    const existing =
      nextByPaneKey.get(hostEntry.paneKey) ?? state.agentStatusByPaneKey.get(hostEntry.paneKey)
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
    // The host owns the launch fact whichever writer wins presentation.
    const accepted =
      nextEntry === entry
        ? entry
        : withHostOrcaSessionId(
            {
              ...withHostProgramStatus(nextEntry, entry.programStatus),
              ...(entry.launchAttested !== undefined
                ? { launchAttested: entry.launchAttested }
                : {})
            },
            entry
          )
    const source = { ...accepted, isReplay: true }
    const conversation = classifyAgentPaneConversation(
      state,
      accepted,
      source,
      toRuntimeExecutionHostId(environmentId)
    )
    nextByPaneKey.set(entry.paneKey, {
      ...accepted,
      firstStateStartedAt: conversationSessionStartedAt(accepted, existing, conversation, source)
    })
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of agentPaneKeysForTabs(state, mirroredTabIds)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    const existing = state.agentStatusByPaneKey.get(paneKey)
    if (!existing || !isMirroredAgentStatusOwnedBy(existing, environmentId, worktreeId)) {
      continue
    }
    // Explicit retraction retires pane authority after the live-row patch.
    if (isMirroredAgentPaneKeyForTabs(paneKey, retractedTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    if (
      state.agentStatusByPaneKey.get(paneKey)?.paneSleep &&
      survivingSleepingPaneKeys.has(paneKey)
    ) {
      continue
    }
    // Host omission cannot prove OSC-driven exit. Retain owned rows through staleness so wake decays them like local panes instead of erasing them (STA-3107).
    if (isClientOwnedAgentStatus(paneKey, state.agentStatusByPaneKey.get(paneKey))) {
      continue
    }
    nextAgentStatusByPaneKey = nextAgentStatusByPaneKey.replace([[paneKey, null]])
    batchContext?.changedAgentPaneKeys?.add(paneKey)
    changed = true
    aggregateRelevantChange = true
    sortRelevantChange = true
  }

  let retirement: ReturnType<typeof retirePaneLaunchNote> = {}
  let nextConversations = state.agentConversationsByPaneKey ?? {}
  const originalConversations = nextConversations
  const conversationDraft = recordDraft(nextConversations)
  for (const [paneKey, entry] of nextByPaneKey) {
    nextConversations = projectAgentPaneConversation(
      { tabsByWorktree: state.tabsByWorktree, agentConversationsByPaneKey: nextConversations },
      entry,
      (_entries, key, value) => {
        conversationDraft.set(key, value)
        return conversationDraft.view()
      },
      toRuntimeExecutionHostId(environmentId),
      { ...entry, isReplay: true }
    )
    const existing = nextAgentStatusByPaneKey.get(paneKey)
    // The host's retirement of this pane's launch ends the client's copies of its note.
    if (retiresLaunch(existing, entry)) {
      retirement = { ...retirement, ...retirePaneLaunchNote({ ...state, ...retirement }, paneKey) }
    }
    if (
      agentStatusEntryEqual(existing, entry) &&
      existing?.firstStateStartedAt === entry.firstStateStartedAt
    ) {
      continue
    }
    nextAgentStatusByPaneKey = nextAgentStatusByPaneKey.replace([[paneKey, entry]])
    batchContext?.changedAgentPaneKeys?.add(paneKey)
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

  nextConversations = conversationDraft.finish()
  if (!changed && nextConversations === originalConversations) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: aggregateRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch,
    ...(nextConversations !== originalConversations
      ? { agentConversationsByPaneKey: nextConversations }
      : {}),
    ...retirement
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

/** Only the host names its agents: for the same conversation its stamp wins, including no stamp
 *  (a settled miss clearing a pending null); the client never mints or keeps one across keys. */
function withHostOrcaSessionId(next: AgentStatusEntry, host: AgentStatusEntry): AgentStatusEntry {
  if (
    !host.providerSession ||
    !agentProviderSessionsEqual(host.agentType, host.providerSession, next.providerSession)
  ) {
    return next
  }
  const { orcaSessionId: _client, ...rest } = next
  return host.orcaSessionId !== undefined ? { ...rest, orcaSessionId: host.orcaSessionId } : rest
}
