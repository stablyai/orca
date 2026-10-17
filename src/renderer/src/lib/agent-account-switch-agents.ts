/** Every agent the shared account switch knows, by the id its queued restarts carry. */
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import { CLAUDE_ACCOUNT_SWITCH_AGENT } from './claude-account-switch-agent'
import { CODEX_ACCOUNT_SWITCH_AGENT } from './codex-account-switch-agent'

export const ACCOUNT_SWITCH_AGENTS: Record<AccountRestartAgent, AccountSwitchAgent> = {
  claude: CLAUDE_ACCOUNT_SWITCH_AGENT,
  codex: CODEX_ACCOUNT_SWITCH_AGENT
}
