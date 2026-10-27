// Share exhaustive launch-to-telemetry mapping between renderer and main so new agents retain distinct attribution.

import type { AgentKind } from './telemetry-events'
import type { TuiAgent } from './tui-agent'

type ConcreteAgentKind = Exclude<AgentKind, 'other'>

const TUI_AGENT_KIND_BY_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-agent-teams',
  codebuddy: 'codebuddy',
  openclaude: 'openclaude',
  codex: 'codex',
  autohand: 'autohand',
  opencode: 'opencode',
  opencode2: 'opencode2',
  'mimo-code': 'mimo-code',
  pi: 'pi',
  omp: 'omp',
  'prime-agent': 'prime-agent',
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  gemini: 'gemini',
  antigravity: 'antigravity',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'aug',
  cline: 'cline',
  codebuff: 'codebuff',
  freebuff: 'freebuff',
  'command-code': 'command-code',
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
  grok: 'grok',
  devin: 'devin',
  ante: 'ante',
  trae: 'trae',
  muse: 'muse',
  zcode: 'zcode',
  dsh: 'dsh',
  jcode: 'jcode'
} satisfies Record<TuiAgent, ConcreteAgentKind>

// Persisted settings/IPC may contain unknown strings despite the exhaustive type; retain telemetry with other.
export function tuiAgentToAgentKind(agent: TuiAgent): AgentKind {
  return TUI_AGENT_KIND_BY_AGENT[agent] ?? 'other'
}

// Initial-workspace launches carry only agent_kind; reverse-map it to stamp the tab's launch agent.
const AGENT_BY_TUI_AGENT_KIND: Partial<Record<AgentKind, TuiAgent>> = Object.fromEntries(
  Object.entries(TUI_AGENT_KIND_BY_AGENT).map(([agent, kind]) => [kind, agent as TuiAgent])
)

export function agentKindToTuiAgent(kind: AgentKind | null | undefined): TuiAgent | null {
  if (!kind) {
    return null
  }
  return AGENT_BY_TUI_AGENT_KIND[kind] ?? null
}
