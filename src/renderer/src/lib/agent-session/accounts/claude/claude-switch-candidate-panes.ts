import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  resolveCodexPaneSelectionLane
} from '../codex-pane-selection-lane'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { ClaudePaneLookups } from './claude-queued-restart-records'
import type { ClaudeSessionMoveCandidate } from './claude-session-account-move'

export type ClaudeSwitchCandidatePane = ClaudeSessionMoveCandidate & {
  tab: TerminalTab
  laneKey: string
  inLane: boolean
  entry: AgentStatusEntry | undefined
  session: AgentProviderSessionMetadata | undefined
  identifiedBy: 'hook' | 'lookup' | 'none'
}

function* candidateLeaves(
  state: AppState,
  tab: TerminalTab,
  includeUnnamed: boolean
): Generator<{ leafId: string; ptyId: string; entry: AgentStatusEntry | undefined }> {
  const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
  const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(leaves)) {
    const entry = state.agentStatusByPaneKey.get(makePaneKey(tab.id, leafId))
    if (
      ptyId &&
      isTerminalLeafId(leafId) &&
      boundPtyIds.includes(ptyId) &&
      !isForeignMachineCodexPtyId(ptyId) &&
      // Why: without a status entry the turn is unknown, so only restart-all, which moves busy sessions too, takes the pane.
      (entry ? entry.agentType === 'claude' && !entry.structuredHostOwned : includeUnnamed)
    ) {
      yield { leafId, ptyId, entry }
    }
  }
}

export function* claudeSwitchCandidatePanes(
  state: AppState,
  owner: RuntimeClientTarget,
  target: CodexAccountSelectionTarget,
  includeUnnamed: boolean,
  lookups?: ClaudePaneLookups
): Generator<ClaudeSwitchCandidatePane> {
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({ owner, target })
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      for (const { leafId, ptyId, entry } of candidateLeaves(state, tab, includeUnnamed)) {
        const { laneKey } = resolveCodexPaneSelectionLane({ state, tab, ptyId })
        const hooked = normalizeAgentProviderSession(entry?.providerSession) ?? undefined
        const lookedUp = lookups?.get(makePaneKey(tab.id, leafId)) ?? undefined
        yield {
          ptyId,
          worktreeId,
          tabId: tab.id,
          leafId,
          tab,
          laneKey,
          inLane: isLaneInScope(laneKey),
          entry,
          session: hooked ?? lookedUp,
          identifiedBy: hooked ? 'hook' : lookedUp ? 'lookup' : 'none'
        }
      }
    }
  }
}

export function hasSleepingSession(state: AppState, pane: ClaudeSessionMoveCandidate): boolean {
  return !!state.sleepingAgentSessionsByPaneKey[makePaneKey(pane.tabId, pane.leafId)]
    ?.providerSession
}
