import { detectAgentStatusFromTitle } from './agent-title-status'
import { getSyntheticAgentTerminalTitle } from './synthetic-agent-title'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

/** Strongest trusted rest evidence: profile-authorized hook-done (DSH), hook-driven synthetic title, classified identity title, or ready-body (Muse/Qoder).
 * none falls back to quiet foreground. Hook working vetoes rest, but hook done proves it only when profile.hooks permits; Qoder idle titles alone can hide a trust menu. */
export type TuiAgentRestSignal = 'hook-done' | 'synthetic-title' | 'title' | 'ready-body' | 'none'

/** Lanes keyed on agent identity in tui-idle-evidence.ts, which no title table records. */
const IDENTITY_REST_SIGNALS: Partial<Record<TuiAgent, TuiAgentRestSignal>> = {
  dsh: 'hook-done',
  muse: 'ready-body',
  qoder: 'ready-body',
  'qoder-cn': 'ready-body'
}

// Derive from title evidence instead of a duplicate agent table; unsupported identities fall to none.
export function getTuiAgentRestSignal(agent: TuiAgent): TuiAgentRestSignal {
  const identitySignal = IDENTITY_REST_SIGNALS[agent]
  if (identitySignal) {
    return identitySignal
  }
  if (getSyntheticAgentTerminalTitle(agent, 'done') !== null) {
    return 'synthetic-title'
  }
  // Why the process name: the title tables match an agent by the name it runs as.
  if (detectAgentStatusFromTitle(TUI_AGENT_CONFIG[agent].expectedProcess) !== null) {
    return 'title'
  }
  return 'none'
}
