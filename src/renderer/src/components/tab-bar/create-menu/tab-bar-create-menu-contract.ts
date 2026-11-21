import type { WindowsTerminalCapabilities } from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting
} from '../model/use-tab-bar-runtime-model'
import type { NewTabAgentMenuModel } from '../../agent/launch-menu/new-tab-agent-menu-model'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentPickerInventorySource } from '../../agent/agent-picker-inventory-source'
import type { TabAgentLaunchOption } from '../create-entry/tab-agent-launch-options'
import type { useTabAgentMenuLaunch } from '../../agent/launch-menu/AgentMenuItems'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import type { WindowsShellMenuEntry } from './tab-bar-windows-shell-options'

export type TabBarCreateMenuControllerOptions = {
  worktreeId: string
  resolvedGroupId: string
  terminalOnly: boolean
  showAgentLaunchItems?: boolean
  mobileEmulatorEnabled: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  workspaceHasSimulatorTab: boolean
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  defaultWindowsShell: string
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
  agentDetectionTarget: AgentDetectionTarget | undefined
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
}

export type TabBarCreateMenuController = {
  agentMenu: NewTabAgentMenuModel
  /** Read through `useAgentPickerInventoryEntries` in the component that renders the entries. */
  agentPickerInventory: AgentPickerInventorySource
  selectPickerAgent: (agent: AgentPickerEntry['agent']) => void
  launchAgentRow: ReturnType<typeof useTabAgentMenuLaunch>
  newTabMenuOpen: boolean
  setNewTabMenuOpen: (open: boolean) => void
  setCreateMenuQuery: (query: string) => void
  createMenuOptions: TabCreateMenuOption[]
  windowsShellEntries: WindowsShellMenuEntry[] | undefined
  handleSelectCreateMenuOption: (option: TabCreateMenuOption) => void
  launchAgentFromNewTabEntry: (option: TabAgentLaunchOption) => boolean | Promise<boolean>
  runPendingNewTabMenuFocusAfterClose: () => void
  clearPendingNewTabMenuFocusOnUnmount: (node: HTMLDivElement | null) => void
  queueNewActiveTerminalFocusAfterNewTabMenuClose: () => void
  queueTerminalTabFocusAfterNewTabMenuClose: (tabId: string) => void
  queueFocusAfterNewTabMenuClose: (focus: () => void) => void
  showStaticCreateMenuItems: boolean
}
