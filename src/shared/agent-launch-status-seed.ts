import type { AgentType, ParsedAgentStatusPayload } from './agent-status-types'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

/** Launch metadata for a pane whose agent publishes no hook until its first prompt.
 *  `prompt` is empty when the launch does not submit one. */
export type AgentLaunchStatusSeed = { agent: TuiAgent; prompt: string }

/**
 * True when the agent's hook stream stays silent until the user's first prompt,
 * so Orca must seed the spawn-window row from launch metadata instead (#6643).
 */
export function agentSeedsLaunchStatus(agent: TuiAgent | null | undefined): agent is TuiAgent {
  return agent != null && TUI_AGENT_CONFIG[agent].seedsLaunchStatus === true
}

/**
 * The status row a launch publishes before any hook arrives.
 *
 * A submitted prompt means the turn is already running, so the row is `working`.
 * A promptless launch lands the same idle session-boundary `done` row Claude's
 * SessionStart uses (STA-3386): `working` would spin on an idle TUI, and
 * `sessionBoundary` keeps completion-reactive consumers (notifications,
 * automation runs, unread badges) out of it.
 */
export function buildLaunchStatusSeedPayload(
  agentType: AgentType | undefined,
  prompt: string
): ParsedAgentStatusPayload {
  const trimmed = prompt.trim()
  return trimmed
    ? { state: 'working', prompt: trimmed, ...(agentType ? { agentType } : {}) }
    : { state: 'done', prompt: '', ...(agentType ? { agentType } : {}), sessionBoundary: true }
}
