// Mapping from the renderer's `TuiAgent` union (every agent Orca knows how
// to launch) to the closed `agentKindSchema` enum on telemetry events. The
// telemetry enum is a deliberately smaller set — anything not enumerated
// maps to `'other'` so dashboards can spot interest in an agent before its
// slot is added rather than dropping the event.
//
// Lives in `src/shared/` (not the renderer) because main-side telemetry
// emission (`agent_started` from the `pty:spawn` IPC handler) needs the
// same mapping. Centralizing here means a new TuiAgent member is one edit,
// not a sweep across renderer + main.

import type { AgentKind } from './telemetry-events'
import type { TuiAgent } from './types'

export function tuiAgentToAgentKind(agent: TuiAgent): AgentKind {
  switch (agent) {
    case 'claude':
      return 'claude-code'
    case 'codex':
      return 'codex'
    case 'copilot':
      return 'copilot'
    case 'gemini':
      return 'gemini'
    case 'cursor':
      return 'cursor'
    case 'opencode':
      return 'opencode'
    case 'aider':
      return 'aider'
    default:
      return 'other'
  }
}
