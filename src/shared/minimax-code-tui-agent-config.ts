import type { TuiAgentConfig } from './tui-agent-config'

export const MINIMAX_CODE_TUI_AGENT_CONFIG = {
  detectCmd: 'mcode',
  launchCmd: 'mcode',
  // Why: the published CLI sets process.title before starting the TUI.
  expectedProcess: 'minimax-code',
  promptInjectionMode: 'argv',
  // Why: top-level subcommands make the option terminator necessary for positional prompts.
  argvPromptSeparator: '--'
} satisfies TuiAgentConfig
