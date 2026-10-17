import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export type SeededAgentPane = {
  n: number
  agentType?: 'claude' | 'codex'
  state?: AgentStatusEntry['state']
  /** null reports no provider session at all. */
  sessionId?: string | null
  /** The hook's transcript path; null leaves it unreported. */
  transcriptPath?: string | null
  launchAgent?: TerminalTab['launchAgent']
  /** Overrides `pty-<n>`, e.g. for a remote runtime's id. */
  ptyId?: string
}

export const SEEDED_SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'
export const tabId = (n: number): string => `tab-${n}`
export const leafId = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
export const ptyId = (n: number): string => `pty-${n}`
const panePtyId = (pane: SeededAgentPane): string => pane.ptyId ?? ptyId(pane.n)
export const paneKeyOf = (n: number): string => makePaneKey(tabId(n), leafId(n))

function makeTab(pane: SeededAgentPane): TerminalTab {
  return {
    id: tabId(pane.n),
    ptyId: panePtyId(pane),
    worktreeId: 'wt1',
    title: pane.agentType ?? 'zsh',
    customTitle: null,
    color: null,
    sortOrder: pane.n,
    createdAt: pane.n,
    ...(pane.launchAgent ? { launchAgent: pane.launchAgent } : {})
  }
}

function providerSession(pane: SeededAgentPane): AgentStatusEntry['providerSession'] {
  const id = pane.sessionId ?? SEEDED_SESSION_ID
  return pane.transcriptPath
    ? { key: 'session_id', id, transcriptPath: pane.transcriptPath }
    : { key: 'session_id', id }
}

/** Seeds one bound, single-leaf terminal tab per pane in worktree `wt1`. */
export function seedAgentPanes(
  panes: SeededAgentPane[],
  settings: Partial<GlobalSettings> = {}
): void {
  const statuses: Record<string, AgentStatusEntry> = {}
  for (const pane of panes) {
    if (!pane.agentType) {
      continue
    }
    const paneKey = paneKeyOf(pane.n)
    statuses[paneKey] = {
      paneKey,
      tabId: tabId(pane.n),
      state: pane.state ?? 'done',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      agentType: pane.agentType,
      ...(pane.sessionId === null ? {} : { providerSession: providerSession(pane) })
    }
  }
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/dev'), ...settings },
    tabsByWorktree: { wt1: panes.map(makeTab) },
    ptyIdsByTabId: Object.fromEntries(panes.map((pane) => [tabId(pane.n), [panePtyId(pane)]])),
    terminalLayoutsByTabId: Object.fromEntries(
      panes.map((pane) => [
        tabId(pane.n),
        {
          root: { type: 'leaf', leafId: leafId(pane.n) },
          activeLeafId: leafId(pane.n),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId(pane.n)]: panePtyId(pane) }
        }
      ])
    ),
    agentStatusByPaneKey: statuses,
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}
