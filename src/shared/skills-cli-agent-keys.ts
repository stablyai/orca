import type { TuiAgent } from './tui-agent'

/** Community skills --agent keys differ from Orca IDs (claude-code, rovodev, augment).
 * Unknown mappings are null because guessed keys abort installation; aider-desk and openclaw are different products. */
export const SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-code',
  codebuddy: 'codebuddy',
  // Follow native-chat skillSourceOwner (claude); Orca’s direct installer separately targets .openclaude roots.
  openclaude: 'claude-code',
  codex: 'codex',
  autohand: 'autohand-code',
  opencode: 'opencode',
  opencode2: 'opencode',
  'mimo-code': null,
  pi: 'pi',
  omp: null,
  'prime-agent': null,
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  gemini: 'gemini-cli',
  antigravity: 'antigravity',
  aider: null,
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro-cli',
  crush: 'crush',
  aug: 'augment',
  cline: 'cline',
  codebuff: null,
  freebuff: null,
  'command-code': 'command-code',
  continue: 'continue',
  cursor: 'cursor',
  droid: 'droid',
  kimi: 'kimi-code-cli',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovodev',
  hermes: 'hermes-agent',
  openclaw: 'openclaw',
  copilot: 'github-copilot',
  grok: 'grok',
  devin: 'devin',
  ante: null,
  // Only TRAE CN ships the traecli alias Orca detects.
  trae: 'trae-cn',
  muse: null,
  zcode: 'zcode',
  // DSH uses Cordis plugins rather than a skills --agent target.
  dsh: null,
  jcode: null
} satisfies Record<TuiAgent, string | null>
