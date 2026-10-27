import type { AgentType } from './agent-status-types'
import type { TerminalAgent } from './terminal-agent'
import { isTuiAgent } from './tui-agent-config'

const ICONABLE_AGENT_TYPES: Record<TerminalAgent, true> = {
  claude: true,
  'claude-agent-teams': true,
  codebuddy: true,
  openclaude: true,
  codex: true,
  autohand: true,
  opencode: true,
  opencode2: true,
  'mimo-code': true,
  pi: true,
  omp: true,
  'prime-agent': true,
  qoder: true,
  'qoder-cn': true,
  gemini: true,
  antigravity: true,
  aider: true,
  goose: true,
  amp: true,
  kilo: true,
  kiro: true,
  crush: true,
  aug: true,
  cline: true,
  codebuff: true,
  freebuff: true,
  'command-code': true,
  continue: true,
  cursor: true,
  droid: true,
  kimi: true,
  'mistral-vibe': true,
  'qwen-code': true,
  rovo: true,
  hermes: true,
  openclaw: true,
  copilot: true,
  grok: true,
  devin: true,
  ante: true,
  trae: true,
  muse: true,
  zcode: true,
  dsh: true,
  dsb: true,
  jcode: true
}

// Why: return null (not a 'claude' fallback) for unknown so Codex panes don't flash the Claude icon before the hook fires.
export function agentTypeToIconAgent(
  agentType: AgentType | null | undefined
): TerminalAgent | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  if (agentType === 'dsb') {
    return 'dsb'
  }
  return isTuiAgent(agentType) && Object.hasOwn(ICONABLE_AGENT_TYPES, agentType) ? agentType : null
}
