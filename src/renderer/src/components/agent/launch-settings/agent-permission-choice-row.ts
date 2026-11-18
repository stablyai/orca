import type { AgentChatPermissionMode } from '../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentPermissionChoice } from '../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'

export type AgentPermissionChoiceRow = {
  chatOwnSupported?: boolean
  choices: readonly AgentPermissionChoice[]
  choice: AgentPermissionChoice
  source: 'agent' | 'all'
  terminalChoice?: AgentPermissionChoice
  chatChoice?: AgentChatPermissionMode | null
  /** What this agent gets from the all-agents choice. */
  defaultChoice: AgentPermissionChoice
  onSelect: (choice: AgentPermissionChoice | 'default') => void
  /** The flag terminals add, shown as a chip in Arguments; empty when none. */
  flag: string
  /** The agent's own Arguments set permissions, so terminals use those instead. */
  argsSetPermission: boolean
}
