// Mapping from the renderer's `TuiAgent` union (every agent Orca knows how
// to launch) to the closed `agentKindSchema` enum on telemetry events. Every
// shipped agent maps to a concrete telemetry value so dashboards can
// distinguish launch interest instead of collapsing the long tail to `other`.
//
// Lives in `src/shared/` (not the renderer) because main-side telemetry
// emission (`agent_started` from the `pty:spawn` IPC handler) needs the
// same mapping. Centralizing here means a new TuiAgent member is one edit,
// not a sweep across renderer + main.

import type { AgentKind } from './telemetry-events'
import type { TuiAgent } from './types'

type ConcreteAgentKind = Exclude<AgentKind, 'other'>

const TUI_AGENT_KIND_BY_AGENT = {
  claude: 'claude-code',
  codex: 'codex',
  autohand: 'autohand',
  opencode: 'opencode',
  pi: 'pi',
  gemini: 'gemini',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'aug',
  cline: 'cline',
  codebuff: 'codebuff',
  continue: 'continue',
  cursor: 'cursor',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes',
  openclaw: 'openclaw',
  copilot: 'copilot',
  grok: 'grok'
} satisfies Record<TuiAgent, ConcreteAgentKind>

// Why: `satisfies Record<TuiAgent, …>` makes the lookup exhaustive at compile
// time, but stale persisted settings or unsafe IPC casts can carry a string
// outside the union at runtime — fall back to `'other'` so the event still
// emits instead of failing validation and dropping silently.
export function tuiAgentToAgentKind(agent: TuiAgent): AgentKind {
  return TUI_AGENT_KIND_BY_AGENT[agent] ?? 'other'
}
