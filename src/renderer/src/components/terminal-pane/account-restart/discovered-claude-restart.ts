import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  discoveredRestartAccountLabel,
  lookUpClaudePaneSession
} from '@/lib/agent-session/accounts/claude/claude-pane-session-lookup'
import {
  restoreQueuedClaudeRestart,
  type QueuedClaudeRestart
} from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { warnSessionsLeftBehind } from '@/lib/provider-accounts/claude-account-switch-notices'
import type { AgentAccountRestartStartup } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { holdsClaudeRestartForTurn } from './pane-account-restart-readiness'

export async function lookUpDiscoveredClaudeRestart(
  agent: AccountRestartAgent,
  pane: { ptyId: string; tabId: string; leafId: string },
  queued: QueuedClaudeRestart | undefined,
  build: (session: AgentProviderSessionMetadata) => AgentAccountRestartStartup | null,
  retrying = false
): Promise<AgentAccountRestartStartup | null> {
  const carried = queued?.session
  if (agent !== 'claude' || !queued || !carried) {
    return null
  }
  // Why: main stops the old terminal before a spawn can be rejected, so a retry has nothing left to look up.
  const session = retrying ? carried : await lookUpClaudePaneSession(pane.ptyId)
  const state = useAppStore.getState()
  if (state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] !== pane.ptyId) {
    warnDiscoveredClaudeNotMoved()
    return null
  }
  if (holdsClaudeRestartForTurn(state, makePaneKey(pane.tabId, pane.leafId), queued.restartAll)) {
    requeueRestart(pane.ptyId, agent, queued)
    return null
  }
  const startup = session && session.id === carried.id ? build(session) : null
  if (!session || !startup) {
    warnDiscoveredClaudeNotMoved()
    return null
  }
  queued.session = session
  return startup
}

export function warnDiscoveredClaudeNotMoved(): void {
  warnSessionsLeftBehind(1, discoveredRestartAccountLabel())
}

function hookNamesSession(pane: { tabId: string; leafId: string }): boolean {
  const entry = useAppStore.getState().agentStatusByPaneKey[makePaneKey(pane.tabId, pane.leafId)]
  return !!normalizeAgentProviderSession(entry?.providerSession)
}

export function restartsOnLookedUpSession(
  pane: { tabId: string; leafId: string },
  queued: QueuedClaudeRestart | undefined
): boolean {
  return !!queued?.session && !hookNamesSession(pane)
}

export function warnsLostClaudeRecord(
  agent: AccountRestartAgent | null,
  pane: { tabId: string; leafId: string },
  queued: QueuedClaudeRestart | undefined
): boolean {
  if (agent !== 'claude' || queued || hookNamesSession(pane)) {
    return false
  }
  warnDiscoveredClaudeNotMoved()
  return true
}

export function requeueRestart(
  ptyId: string,
  agent: AccountRestartAgent,
  queued: QueuedClaudeRestart | undefined
): void {
  if (queued) {
    restoreQueuedClaudeRestart(ptyId, queued)
  }
  useAppStore.getState().queuePaneAccountRestarts([ptyId], agent)
}
