import type { TuiAgent } from './tui-agent'

/** English names for shared/nonlocalized keybinding surfaces; keep aligned with renderer agent-catalog.tsx labels. */
export const TUI_AGENT_DISPLAY_NAMES: Record<TuiAgent, string> = {
  claude: 'Claude',
  'claude-agent-teams': 'Claude Agent Teams',
  codebuddy: 'CodeBuddy',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  devin: 'Devin',
  ante: 'Ante',
  trae: 'Trae',
  doubao: 'Doubao',
  muse: 'Muse',
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode',
  autohand: 'Autohand Code',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  'mimo-code': 'MiMo Code',
  pi: 'Pi',
  omp: 'OMP',
  'prime-agent': 'Prime Agent',
  qoder: 'Qoder CLI',
  'qoder-cn': 'Qoder CLI China',
  antigravity: 'Antigravity',
  aider: 'Aider',
  goose: 'Goose',
  amp: 'Amp',
  kilo: 'Kilocode',
  kiro: 'Kiro',
  crush: 'Charm',
  aug: 'Auggie',
  cline: 'Cline',
  codebuff: 'Codebuff',
  freebuff: 'Freebuff',
  'command-code': 'Command Code',
  continue: 'Continue',
  cursor: 'Cursor',
  droid: 'Droid',
  kimi: 'Kimi',
  'mistral-vibe': 'Mistral Vibe',
  'qwen-code': 'Qwen Code',
  rovo: 'Rovo Dev',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  copilot: 'GitHub Copilot',
  grok: 'Grok',
  jcode: 'Jcode'
}

/** Derive the exhaustive list here so shared modules need no renderer import. */
export const ALL_TUI_AGENTS = Object.keys(TUI_AGENT_DISPLAY_NAMES) as readonly TuiAgent[]

export type AgentNameTranslator = (key: string, fallback: string) => string

export function localizeAgentDisplayName(
  agent: string,
  fallback: string,
  t?: AgentNameTranslator
): string {
  return agent === 'doubao' && t ? t('auto.lib.agent.catalog.doubao_label', 'Doubao') : fallback
}

/** The display name of `agent`, or null when it names no TUI agent. */
export function tuiAgentDisplayName(agent: string, t?: AgentNameTranslator): string | null {
  return Object.hasOwn(TUI_AGENT_DISPLAY_NAMES, agent)
    ? localizeAgentDisplayName(agent, TUI_AGENT_DISPLAY_NAMES[agent as TuiAgent], t)
    : null
}
