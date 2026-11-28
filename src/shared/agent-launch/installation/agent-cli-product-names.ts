import type { AgentCliUpdateAgent } from './agent-cli-update'

/** The product the user installed, as its own docs name it; desktop and phone translate from these. */
export const AGENT_CLI_PRODUCT_NAMES: Record<AgentCliUpdateAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  grok: 'Grok Build',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  omp: 'OMP',
  copilot: 'GitHub Copilot CLI',
  kimi: 'Kimi Code',
  cursor: 'Cursor CLI',
  hermes: 'Hermes Agent',
  goose: 'Goose CLI',
  aug: 'Auggie',
  kilo: 'Kilo CLI',
  'mimo-code': 'MiMo Code',
  'qwen-code': 'Qwen Code',
  devin: 'Devin CLI',
  codebuddy: 'CodeBuddy Code',
  antigravity: 'Antigravity CLI'
}

/** Copilot's full name crowds a list row. */
export const AGENT_CLI_COPILOT_SHORT_PRODUCT_NAME = 'Copilot CLI'
