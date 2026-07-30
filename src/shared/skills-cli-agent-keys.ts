import type { TuiAgent } from './types'

/**
 * The community `skills` CLI's own `--agent` key for each agent Orca detects.
 *
 * Why: `skills add` validates `--agent` against its own namespace and exits 1 on
 * an unknown key, so anything we are not certain of maps to null and is dropped
 * rather than guessed. Orca ids and skills keys agree less often than they look
 * (`claude` is `claude-code`, `rovo` is `rovodev`, `aug` is `augment`), and some
 * near-matches are different products — Orca's `aider` CLI is not the CLI's
 * `aider-desk`, and Orca's `openclaude` is not its `openclaw`.
 */
export const SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-code',
  openclaude: null,
  codex: 'codex',
  autohand: 'autohand-code',
  opencode: 'opencode',
  'mimo-code': null,
  pi: 'pi',
  omp: null,
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
  trae: 'trae'
} satisfies Record<TuiAgent, string | null>

/**
 * The shared `.agents/skills` target every universal agent reads. Always included
 * so agents Orca cannot map still receive the skill.
 */
export const SKILLS_CLI_UNIVERSAL_AGENT_KEY = 'universal'

/** Map detected Orca agents onto `skills --agent` keys, plus the universal target. */
export function toSkillsCliAgentKeys(detectedAgents: readonly TuiAgent[]): string[] {
  const keys = new Set<string>([SKILLS_CLI_UNIVERSAL_AGENT_KEY])
  for (const agent of detectedAgents) {
    const key = SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT[agent]
    if (key) {
      keys.add(key)
    }
  }
  return [...keys].sort()
}
