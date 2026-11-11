import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { RuntimeTerminalAttention } from '../../../../../shared/runtime-terminal-contracts'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'

export type AgentHibernationPlannerSnapshot = {
  settings: Pick<GlobalSettings, 'experimentalAgentHibernation' | 'agentHibernationIdleMs'> | null
  activeWorktreeId: string | null
  foregroundTerminalTabIds: string[]
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  ptyIdsByTabId: Record<string, string[] | undefined>
  runtimeLivePtyIdsByWorktreeId?: Record<string, string[] | undefined>
  runtimeLivenessRequiredWorktreeIds?: string[]
  /** Driven by a phone; this window's own view is foregroundTerminalTabIds. */
  inUsePtyIds: string[]
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  lastTerminalInputAtByPaneKey: Record<string, number | undefined>
  /** Per worktree, keyed by its host's PTY id: shown on a paired client or phone, and input from any client.
   *  Absent where the host can't report it. */
  attentionByWorktreeId?: Record<
    string,
    Record<string, RuntimeTerminalAttention | undefined> | undefined
  >
  foregroundTerminalLastSeenAtByTabId: Record<string, number | undefined>
  ptyBindingFirstSeenAtByPaneKey?: Record<string, number | undefined>
  boundaryResolvedAtByPaneKey?: Record<string, number | undefined>
  now: number
}
