import { useEffect, useMemo, useRef, useState } from 'react'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { useAppStore } from '../../store'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import { useTabAgentMenuLaunch } from './QuickLaunchButton'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { useNewTabAgentMenuRows, type NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { buildTabAgentLaunchOptionsFromRows } from './tab-agent-launch-options'
import { buildTabCreateMenuOptions, type TabCreateMenuOption } from './tab-create-menu-options'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import {
  buildWindowsShellMenuEntries,
  type WindowsShellMenuEntry
} from './tab-bar-windows-shell-options'
import type {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting
} from './use-tab-bar-runtime-model'
const NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS = 50
const NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS = 5000
export type TabBarCreateMenuController = {
  agentMenu: NewTabAgentMenuModel
  agentLaunchOptions: TabAgentLaunchOption[]
  launchAgentRow: ReturnType<typeof useTabAgentMenuLaunch>
  newTabMenuOpen: boolean
  setNewTabMenuOpen: (open: boolean) => void
  setCreateMenuQuery: (query: string) => void
  createMenuOptions: TabCreateMenuOption[]
  windowsShellEntries: WindowsShellMenuEntry[] | undefined
  handleSelectCreateMenuOption: (option: TabCreateMenuOption) => void
  launchAgentFromNewTabEntry: (option: TabAgentLaunchOption) => void
  runPendingNewTabMenuFocusAfterClose: () => void
  clearPendingNewTabMenuFocusOnUnmount: (node: HTMLDivElement | null) => void
  queueNewActiveTerminalFocusAfterNewTabMenuClose: () => void
  queueTerminalTabFocusAfterNewTabMenuClose: (tabId: string) => void
  queueFocusAfterNewTabMenuClose: (focus: () => void) => void
  showStaticCreateMenuItems: boolean
}
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
    agentDetectionTarget
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agentLaunchOptions = buildTabAgentLaunchOptionsFromRows(
    agentMenu.state === 'settled' ? agentMenu.rows : [],
    commandOverrides
  )
  const pendingNewTabMenuFocusRef = useRef<{ focus: () => void; synchronous?: true } | null>(null)
  const pendingNewTabMenuFocusAnimationRef = useRef<number | null>(null)
  const pendingNewTabMenuFocusRetryRef = useRef<number | null>(null)
  const clearPendingNewTabMenuFocusAnimation = (): void => {
    if (pendingNewTabMenuFocusAnimationRef.current !== null) {
      cancelAnimationFrame(pendingNewTabMenuFocusAnimationRef.current)
      pendingNewTabMenuFocusAnimationRef.current = null
    }
  }
  const clearPendingNewTabMenuFocusRetry = (): void => {
    if (pendingNewTabMenuFocusRetryRef.current !== null) {
      window.clearTimeout(pendingNewTabMenuFocusRetryRef.current)
      pendingNewTabMenuFocusRetryRef.current = null
    }
  }
  const focusNewActiveTerminalWhenReady = (
    previousActiveTabId: string | null,
    expiresAt: number,
    now: number
  ): void => {
    const state = useAppStore.getState()
    if (
      (state.activeTabType === 'terminal' || state.activeTabType === 'simulator') &&
      state.activeTabId &&
      state.activeTabId !== previousActiveTabId
    ) {
      focusTerminalTabSurface(state.activeTabId)
      return
    }
    if (now >= expiresAt) {
      return
    }
    pendingNewTabMenuFocusRetryRef.current = window.setTimeout(() => {
      pendingNewTabMenuFocusRetryRef.current = null
      focusNewActiveTerminalWhenReady(previousActiveTabId, expiresAt, Date.now())
    }, NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS)
  }
  const queueNewActiveTerminalFocusAfterNewTabMenuClose = (): void => {
    const previousActiveTabId = useAppStore.getState().activeTabId
    queueFocusAfterNewTabMenuClose(() => {
      // Why: paired web/SSH tab creation is async; await the host snapshot's new terminal instead of the pre-existing active tab.
      focusNewActiveTerminalWhenReady(
        previousActiveTabId,
        Date.now() + NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS,
        Date.now()
      )
    })
  }
  const queueTerminalTabFocusAfterNewTabMenuClose = (tabId: string): void =>
    queueFocusAfterNewTabMenuClose(() => focusTerminalTabSurface(tabId))
  const queueFocusAfterNewTabMenuClose = (focus: () => void, synchronous?: true): void => {
    clearPendingNewTabMenuFocusAnimation()
    clearPendingNewTabMenuFocusRetry()
    pendingNewTabMenuFocusRef.current = { focus, synchronous }
  }
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
  const createMenuOptions = useMemo(
    () =>
      buildTabCreateMenuOptions({
        terminalOnly,
        windowsShellEntries,
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
  const launchAgentFromNewTabEntry = (option: TabAgentLaunchOption): void => {
    if (option.row) {
      launchAgentRow(option.row)
    }
  }
  const runPendingNewTabMenuFocusAfterClose = (): void => {
    const pendingFocus = pendingNewTabMenuFocusRef.current
    pendingNewTabMenuFocusRef.current = null
    clearPendingNewTabMenuFocusAnimation()
    clearPendingNewTabMenuFocusRetry()
    if (pendingFocus?.synchronous) {
      pendingFocus.focus()
    } else if (pendingFocus) {
      pendingNewTabMenuFocusAnimationRef.current = requestAnimationFrame(() => {
        pendingNewTabMenuFocusAnimationRef.current = null
        pendingFocus.focus()
      })
    }
  }
  const menuFocusUnmountRef = useRef<((node: HTMLDivElement | null) => void) | null>(null)
  if (menuFocusUnmountRef.current === null) {
    menuFocusUnmountRef.current = (node: HTMLDivElement | null): void => {
      if (node !== null) {
        return
      }
      // Why: cancel the delayed focus handoff via this root ref cleanup, avoiding an otherwise cleanup-only React Effect.
      pendingNewTabMenuFocusRef.current = null
      clearPendingNewTabMenuFocusAnimation()
      clearPendingNewTabMenuFocusRetry()
    }
  }
  useEffect(() => {
    if (!newTabMenuOpen) {
      return
    }
    const dismiss = (): void => setNewTabMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [newTabMenuOpen])
  useEffect(() => {
    if (!newTabMenuOpen) {
      setCreateMenuQuery('')
    }
  }, [newTabMenuOpen])
  return {
    agentMenu,
    agentLaunchOptions,
    launchAgentRow,
    newTabMenuOpen,
    setNewTabMenuOpen,
    setCreateMenuQuery,
    createMenuOptions,
    windowsShellEntries,
    handleSelectCreateMenuOption,
    launchAgentFromNewTabEntry,
    runPendingNewTabMenuFocusAfterClose,
    clearPendingNewTabMenuFocusOnUnmount: menuFocusUnmountRef.current,
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueTerminalTabFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    showStaticCreateMenuItems: createMenuQuery.trim().length === 0
  }
}
