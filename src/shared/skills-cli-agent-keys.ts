import type { TuiAgent } from './tui-agent'

/**
 * The community `skills` CLI's own `--agent` key for each agent Orca detects.
 *
 * Why: `skills add` validates `--agent` against its own namespace and exits 1 on
 * an unknown key, so anything we are not certain of maps to null and is dropped
 * rather than guessed. Orca ids and skills keys agree less often than they look
 * (`claude` is `claude-code`, `rovo` is `rovodev`, `aug` is `augment`), and some
 * near-matches are different products — Orca's `aider` CLI is not the CLI's
 * `aider-desk`, and Orca's `openclaude` is its `openclaw` in name only, so it
 * follows Orca's own rule that OpenClaude reads Claude-owned roots.
 */
export const SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-code',
  codebuddy: 'codebuddy',
  // Why: Orca states OpenClaude reads Claude-owned roots (native-chat-agent-profiles).
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
  // Why: Orca detects trae by `traecli`, an alias only TRAE CN ships.
  trae: 'trae-cn',
  muse: null,
  zcode: 'zcode',
  // Why: DSH ships skills as Cordis plugins, not a `skills --agent` target.
  dsh: null,
  jcode: null
} satisfies Record<TuiAgent, string | null>
