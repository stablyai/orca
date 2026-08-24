import type { TuiAgentConfig } from './tui-agent-config'

export const ZCODE_TUI_AGENT_CONFIG: TuiAgentConfig = {
  detectCmd: 'zcode',
  launchCmd: 'zcode',
  expectedProcess: 'zcode-cli',
  promptInjectionMode: 'stdin-after-start'
}
