import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { TabCreateEntryArgs } from './tab-create-entry-action'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'

export type TabBarCreateEntryProps = {
  agentPickerEntries?: readonly AgentPickerEntry[]
  agentOptions?: readonly TabAgentLaunchOption[]
  groupId: string
  menuOpen: boolean
  menuOptions?: readonly TabCreateMenuOption[]
  onDidOpenEntry?: () => void
  /** Legacy agent-only callback for callers that do not project surfaces. */
  onLaunchAgent?: (agent: TabAgentLaunchOption['agent']) => void
  onLaunchAgentOption?: (option: TabAgentLaunchOption) => void
  onOpenDefaultTerminal?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  onQueryChange?: (query: string) => void
  /** Runs after the menu closes, so the tab jumped to actually takes focus. */
  onQueueSwitchFocus?: (focus: () => void) => void
  onSelectMenuOption?: (option: TabCreateMenuOption) => void
  worktreeId: string
}
