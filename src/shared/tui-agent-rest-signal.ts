import { detectAgentStatusFromTitle } from './agent-title-status'
import { getSyntheticAgentTerminalTitle } from './synthetic-agent-title'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

/**
 * The strongest lane tui-idle-evidence.ts trusts to say an agent's TUI is at rest:
 * - `hook-done`: its own hook reports the lead turn ended (DSH).
 * - `synthetic-title`: its hooks drive an Orca-written `<Agent> ready` title.
 * - `title`: its running process names itself in a title the status classifier reads.
 * - `ready-body`: a ready screen Orca recognises (Muse; Qoder, whose idle title can show while
 *   its trust menu still owns input).
 * - `none`: no stronger lane, so a quiet foreground process is its only one. Hooks or a first-party
 *   `done` (amp, kimi, command-code, freebuff) do not count: tui-idle takes their `working` as a
 *   veto, and trusts a first-party `done` only from DSH.
 */
export type TuiAgentRestSignal = 'hook-done' | 'synthetic-title' | 'title' | 'ready-body' | 'none'

/** Lanes keyed on agent identity in tui-idle-evidence.ts, which no title table records. */
const IDENTITY_REST_SIGNALS: Partial<Record<TuiAgent, TuiAgentRestSignal>> = {
  dsh: 'hook-done',
  muse: 'ready-body',
  qoder: 'ready-body',
  'qoder-cn': 'ready-body'
}

// Why derived, not declared per agent: the title tables are the evidence, so a second
// hand-kept copy could only drift from them. An agent with no evidence falls to `none`.
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
