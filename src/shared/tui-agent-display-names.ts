import type { TuiAgent } from './types'

/** Why: plain-English agent names for non-localized surfaces (keybinding
 * titles in the shared registry, which main, renderer, and the keybindings
 * file sanitizer all read). The renderer's localized agent catalog
 * (`agent-catalog.tsx`) stays the source of truth for UI labels; keep these
 * in sync with its `label` values when adding an agent. */
export const TUI_AGENT_DISPLAY_NAMES: Record<TuiAgent, string> = {
  claude: 'Claude',
  'claude-agent-teams': 'Claude Agent Teams',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  devin: 'Devin',
  ante: 'Ante',
  autohand: 'Autohand Code',
  opencode: 'OpenCode',
  'mimo-code': 'MiMo Code',
  pi: 'Pi',
  omp: 'OMP',
  gemini: 'Gemini',
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
  grok: 'Grok'
}

/** Canonical agent id list derived from the exhaustive display-name record,
 * so shared modules can enumerate agents without importing renderer code. */
export const ALL_TUI_AGENTS = Object.keys(TUI_AGENT_DISPLAY_NAMES) as readonly TuiAgent[]
