import type { TabBarCreateMenuController } from './tab-bar-create-menu-contract'
export type { TabBarCreateMenuController } from './tab-bar-create-menu-contract'
import { useAgentLaunchPickerInventorySource } from '../agent/use-agent-launch-picker-inventory'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { useEffect, useMemo, useState } from 'react'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { useTabAgentMenuLaunch } from './QuickLaunchButton'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import { buildTabCreateMenuOptions, type TabCreateMenuOption } from './tab-create-menu-options'
import { useNewTabMenuFocusHandoff } from './use-new-tab-menu-focus-handoff'
import { useTabBarSystemMonitors } from './use-tab-bar-system-monitors'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import { buildWindowsShellMenuEntries } from './tab-bar-windows-shell-options'
import type {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting
} from './use-tab-bar-runtime-model'

export function useTabBarCreateMenuController({
  worktreeId,
  resolvedGroupId,
  terminalOnly,
  showAgentLaunchItems = true,
  mobileEmulatorEnabled,
  managedBrowserCreationEnabled,
  mobileEmulatorCreationEnabled,
  workspaceHasSimulatorTab,
  showWindowsShellMenu,
  projectRuntimeShellMenuMode,
  defaultWindowsShell,
  defaultWindowsPowerShellImplementation,
  agentDetectionTarget,
  windowsTerminalCapabilities,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onNewBrowserTab,
  onNewSimulatorTab,
  onNewFileTab,
  onOpenFileTab
}: {
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
}): TabBarCreateMenuController {
  // Why: <webview> clicks are out-of-process, so Radix's document-pointerdown outside-click check misses them; use window blur.
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [createMenuQuery, setCreateMenuQuery] = useState('')
  const agentMenu = useNewTabAgentMenuRows(
    worktreeId,
    newTabMenuOpen && showAgentLaunchItems,
    agentDetectionTarget,
    { wakeOnOpen: true }
  )
  const [selectedPickerAgent, selectPickerAgent] = useState<AgentPickerEntry['agent']>()
  // Why: subscribed inside the open menu only; catalog reads landing here would re-render the tab bar.
  const agentPickerInventory = useAgentLaunchPickerInventorySource(
    worktreeId,
    agentMenu,
    newTabMenuOpen && showAgentLaunchItems,
    selectedPickerAgent
  )
  const {
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueTerminalTabFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    runPendingNewTabMenuFocusAfterClose,
    clearPendingNewTabMenuFocusOnUnmount
  } = useNewTabMenuFocusHandoff()

  const windowsShellEntries = useMemo(() => {
    return buildWindowsShellMenuEntries({
      showWindowsShellMenu,
      hasShellLauncher: Boolean(onNewTerminalWithShell),
      projectRuntimeShellMenuMode,
      defaultWindowsShell,
      gitBashAvailable: windowsTerminalCapabilities.gitBashAvailable,
      wslAvailable: windowsTerminalCapabilities.wslAvailable
    })
  }, [
    defaultWindowsShell,
    onNewTerminalWithShell,
    projectRuntimeShellMenuMode,
    showWindowsShellMenu,
    windowsTerminalCapabilities.gitBashAvailable,
    windowsTerminalCapabilities.wslAvailable
  ])
  const { systemMonitors, handleLaunchSystemMonitor } = useTabBarSystemMonitors({
    worktreeId,
    groupId: resolvedGroupId,
    open: newTabMenuOpen,
    target: agentDetectionTarget,
    onBeforeLaunch: queueNewActiveTerminalFocusAfterNewTabMenuClose
  })
  const createMenuOptions = useMemo(
    () =>
      buildTabCreateMenuOptions({
        terminalOnly,
        windowsShellEntries,
        systemMonitors,
        hasNewBrowser: !terminalOnly && managedBrowserCreationEnabled,
        hasNewMarkdown: !terminalOnly && Boolean(onNewFileTab),
        hasOpenMarkdown: !terminalOnly && Boolean(onOpenFileTab),
        hasSimulator:
          !terminalOnly &&
          mobileEmulatorEnabled &&
          mobileEmulatorCreationEnabled &&
          Boolean(onNewSimulatorTab),
        simulatorIsGoTo: workspaceHasSimulatorTab
      }),
    [
      mobileEmulatorEnabled,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      onNewFileTab,
      onNewSimulatorTab,
      onOpenFileTab,
      systemMonitors,
      terminalOnly,
      windowsShellEntries,
      workspaceHasSimulatorTab
    ]
  )
  const handleSelectCreateMenuOption = (option: TabCreateMenuOption): void => {
    switch (option.kind) {
      case 'new-terminal':
        queueNewActiveTerminalFocusAfterNewTabMenuClose()
        onNewTerminalTab()
        break
      case 'new-terminal-shell':
        if (!onNewTerminalWithShell || !option.shell) {
          break
        }
        queueNewActiveTerminalFocusAfterNewTabMenuClose()
        onNewTerminalWithShell(
          resolveWindowsShellLaunchTarget(
            option.shell,
            defaultWindowsPowerShellImplementation,
            windowsTerminalCapabilities.pwshAvailable
          )
        )
        break
      case 'new-browser':
        onNewBrowserTab()
        break
      case 'new-markdown':
        onNewFileTab?.()
        break
      case 'open-markdown':
        onOpenFileTab?.()
        break
      case 'new-simulator':
      case 'go-to-simulator':
        onNewSimulatorTab?.()
        break
      case 'launch-monitor':
        if (option.monitor) {
          handleLaunchSystemMonitor(option.monitor)
        }
        break
      case 'new-plugin-file': // usePluginNewFileMenuOptions handles these first.
    }
  }
  const launchAgentRow = useTabAgentMenuLaunch({
    worktreeId,
    groupId: resolvedGroupId,
    launchSource: 'tab_bar_quick_launch',
    onFocusTerminal: queueTerminalTabFocusAfterNewTabMenuClose,
    onFocusHostTerminal: queueNewActiveTerminalFocusAfterNewTabMenuClose,
    onFocusChat: (tabId) =>
      queueFocusAfterNewTabMenuClose(() => requestNativeChatComposerFocus(tabId), true)
  })
  const launchAgentFromNewTabEntry = (option: TabAgentLaunchOption) => {
    if (option.row) {
      return option.setup
        ? launchAgentRow(option.row, option.setup, option.pickerEntry)
        : launchAgentRow(option.row)
    }
    return false
  }
  useEffect(() => {
    if (!newTabMenuOpen) {
      return
    }
    const dismiss = (): void => setNewTabMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [newTabMenuOpen])
  const [prevNewTabMenuOpen, setPrevNewTabMenuOpen] = useState(newTabMenuOpen)
  if (prevNewTabMenuOpen !== newTabMenuOpen) {
    setPrevNewTabMenuOpen(newTabMenuOpen)
    if (!newTabMenuOpen) {
      setCreateMenuQuery('')
    }
  }
  return {
    agentMenu,
    agentPickerInventory,
    selectPickerAgent,
    launchAgentRow,
    newTabMenuOpen,
    setNewTabMenuOpen,
    setCreateMenuQuery,
    createMenuOptions,
    windowsShellEntries,
    systemMonitors,
    handleLaunchSystemMonitor,
    handleSelectCreateMenuOption,
    launchAgentFromNewTabEntry,
    runPendingNewTabMenuFocusAfterClose,
    clearPendingNewTabMenuFocusOnUnmount,
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueTerminalTabFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    showStaticCreateMenuItems: createMenuQuery.trim().length === 0
  }
}
