/* oxlint-disable max-lines -- Why: rendering the drop-indicator prop on each
 * of three distinct tab components (terminal, browser, editor) adds 3 lines
 * to a file that was already ~398 code lines on main. The per-type render
 * branches share little beyond drag data, so consolidating them would cost
 * more clarity than the ~5 lines of bloat is worth. */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import {
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FileText,
  Globe,
  Plus,
  Smartphone,
  TerminalSquare
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TerminalTab,
  TuiAgent,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { buildStatusMap } from '../right-sidebar/status-display'
import type { OpenFile } from '../../store/slices/editor'
import SortableTab from './SortableTab'
import EditorFileTab from './EditorFileTab'
import BrowserTab, { getBrowserTabLabel } from './BrowserTab'
import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import type { DropIndicator } from './drop-indicator'
import { reconcileTabOrder } from './reconcile-order'
import type { HoveredTabInsertion, TabDragItemData } from '../tab-group/useTabDragSplit'
import { resolveTabIndicatorEdges } from '../tab-group/tab-insertion'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import TabBarCreateEntry from './TabBarCreateEntry'
import { ShellIcon } from './shell-icons'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { type AgentDetectionTarget, useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { normalizeRelativePath } from '@/lib/path'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { useOptionalShortcutLabel, useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  type BuiltInWindowsTerminalShell,
  WINDOWS_GIT_BASH_SHELL
} from '../../../../shared/windows-terminal-shell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import type { TabCreateEntryArgs } from './tab-create-entry-action'
import { buildTabAgentLaunchOptions, orderTabLaunchAgents } from './tab-agent-launch-options'
import { buildTabCreateMenuOptions, type TabCreateMenuOption } from './tab-create-menu-options'
import { MobileEmulatorTabIntroCallout } from '../emulator-pane/MobileEmulatorTabIntroCallout'
import { shouldShowMobileEmulatorTabIntro } from '../emulator-pane/mobile-emulator-tab-intro-visibility'
import { translate } from '@/i18n/i18n'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import { getTabStripScrollMaskClassName } from './tab-strip-scroll-metrics'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import { shouldShowWindowsShellMenu } from './windows-shell-menu-visibility'

const isWindows = navigator.userAgent.includes('Windows')
const isMacOs = navigator.userAgent.includes('Mac')
const NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS = 50
const NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS = 5000
type GitStatusEntries = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree'][string]
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntries = []
const EMPTY_AGENT_CMD_OVERRIDES: Partial<Record<TuiAgent, string>> = {}
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const AGENT_DETECTION_LOCAL_TARGET_KEY = 'local'

function getProjectRuntimeShellMenuMode(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): 'host' | 'wsl' | null {
  if (!projectRuntime) {
    return null
  }
  if (projectRuntime.status === 'repair-required') {
    return 'wsl'
  }
  return projectRuntime.runtime.kind === 'wsl' ? 'wsl' : 'host'
}

type TabBarProps = {
  tabs: (TerminalTab & { unifiedTabId?: string })[]
  activeTabId: string | null
  groupId?: string
  worktreeId: string
  expandedPaneByTabId: Record<string, boolean>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onNewTerminalTab: () => void
  /** On Windows, opens a new terminal with a specific shell instead of the default. */
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  terminalOnly?: boolean
  showAgentLaunchItems?: boolean
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
  newTabMenuOrder?: 'default' | 'markdown-first'
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: (OpenFile & { tabId?: string })[]
  browserTabs?: (BrowserTabState & { tabId?: string })[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeSimulatorTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onDuplicateBrowserTab?: (tabId: string) => void
  onCloseAllFiles?: () => void
  onMakePreviewFilePermanent?: (fileId: string, tabId?: string) => void
  onPinFile?: (fileId: string, tabId?: string) => void
  tabBarOrder?: string[]
  hoveredTabInsertion?: HoveredTabInsertion | null
  /** Floating workspace panels are rounded; skip tab top borders that clash with the curve. */
  tabStripChrome?: 'default' | 'floating-panel'
}

type TabItem =
  | {
      type: 'terminal'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: TerminalTab & { unifiedTabId?: string }
    }
  | {
      type: 'editor'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: OpenFile & { tabId?: string }
    }
  | {
      type: 'browser'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: BrowserTabState & { tabId?: string }
    }
  | {
      type: 'simulator'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: Tab
    }

function getTabDragLabel(item: TabItem, generatedTitlesEnabled: boolean): string {
  if (item.type === 'terminal') {
    return resolveTerminalTabTitle(item.data, generatedTitlesEnabled, item.data.title)
  }
  if (item.type === 'browser') {
    return getBrowserTabLabel(item.data)
  }
  if (item.type === 'simulator') {
    return item.data.label || 'Mobile Emulator'
  }
  return getEditorDisplayLabel(item.data)
}

function getTabLayoutSignature(
  item: TabItem,
  {
    generatedTitlesEnabled,
    isExpanded,
    status
  }: {
    generatedTitlesEnabled: boolean
    isExpanded: boolean
    status?: string | null
  }
): string {
  const label = getTabDragLabel(item, generatedTitlesEnabled)
  if (item.type === 'terminal') {
    return `${item.type}:${item.id}:${item.isPinned}:${isExpanded}:${Boolean(item.data.color)}:${label}`
  }
  if (item.type === 'browser') {
    return `${item.type}:${item.id}:${item.isPinned}:${item.data.loading}:${item.data.loadError}:${label}`
  }
  if (item.type === 'editor') {
    return `${item.type}:${item.id}:${item.isPinned}:${item.data.isDirty}:${item.data.isPreview}:${item.data.externalMutation ?? ''}:${status ?? ''}:${label}`
  }
  return `${item.type}:${item.id}:${item.isPinned}:${label}`
}

function createUnifiedTabLookup(tabs: readonly Tab[], groupId: string): Map<string, Tab> {
  const lookup = new Map<string, Tab>()
  for (const tab of tabs) {
    if (tab.groupId !== groupId) {
      continue
    }
    lookup.set(tab.id, tab)
    if (tab.contentType === 'terminal' || tab.contentType === 'browser') {
      lookup.set(tab.entityId, tab)
    }
  }
  return lookup
}

function TabBarInner({
  tabs,
  activeTabId,
  groupId,
  worktreeId,
  expandedPaneByTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onNewBrowserTab,
  onNewSimulatorTab,
  onOpenEntry,
  terminalOnly = false,
  showAgentLaunchItems = true,
  onNewFileTab,
  onOpenFileTab,
  newTabMenuOrder = 'default',
  onSetCustomTitle,
  onSetTabColor,
  onTogglePaneExpand,
  editorFiles,
  browserTabs,
  activeFileId,
  activeBrowserTabId,
  activeSimulatorTabId,
  activeTabType,
  onActivateFile,
  onCloseFile,
  onActivateBrowserTab,
  onCloseBrowserTab,
  onDuplicateBrowserTab,
  onCloseAllFiles,
  onMakePreviewFilePermanent,
  onPinFile,
  tabBarOrder,
  hoveredTabInsertion,
  tabStripChrome = 'default'
}: TabBarProps): React.JSX.Element {
  const includeTopTabBorder = tabStripChrome !== 'floating-panel'
  const newTerminalShortcut = useShortcutLabel('tab.newTerminal')
  const newBrowserShortcut = useShortcutLabel('tab.newBrowser')
  const newSimulatorShortcut = useShortcutLabel('tab.newSimulator')
  const newFileShortcut = useShortcutLabel('tab.newMarkdown')
  const openMarkdownShortcut = useOptionalShortcutLabel('tab.openMarkdown')
  const generatedTabTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)
  const mobileEmulatorEnabled = useAppStore((s) => s.settings?.mobileEmulatorEnabled !== false)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const mobileEmulatorTabIntroDismissed = useAppStore((s) => s.mobileEmulatorTabIntroDismissed)
  const showMobileEmulatorIntroCallout = shouldShowMobileEmulatorTabIntro({
    persistedUIReady,
    mobileEmulatorTabIntroDismissed,
    mobileEmulatorEnabled,
    isMacOs
  })
  const gitStatusEntries = useAppStore(
    (s) => s.gitStatusByWorktree[worktreeId] ?? EMPTY_GIT_STATUS_ENTRIES
  )
  const unifiedTabs = useAppStore((s) => s.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS)
  const pinTab = useAppStore((s) => s.pinTab)
  const unpinTab = useAppStore((s) => s.unpinTab)
  const activeGroupIdForWorktree = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const defaultWindowsShell = useAppStore(
    (s) => s.settings?.terminalWindowsShell ?? 'powershell.exe'
  )
  const defaultWindowsPowerShellImplementation = useAppStore(
    (s) => s.settings?.terminalWindowsPowerShellImplementation ?? 'auto'
  )
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const projects = useAppStore((s) => s.projects)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  // Why: probe Windows shell capabilities on the host that owns this worktree, so
  // the offered shells match the host that actually runs the terminal.
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => getRuntimeEnvironmentIdForWorktree(s, worktreeId)?.trim() || null
  )
  const worktreeConnectionId = useAppStore((s) => {
    const worktree = Object.values(s.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === worktreeId)
    const repo = worktree ? s.repos?.find((entry) => entry.id === worktree.repoId) : null
    return repo?.connectionId?.trim() || null
  })
  const worktreeRemotePlatform = useAppStore((s) => {
    if (!worktreeConnectionId) {
      return null
    }
    return s.sshConnectionStates.get(worktreeConnectionId)?.remotePlatform ?? null
  })
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const agentCmdOverrides = useAppStore(
    (s) => s.settings?.agentCmdOverrides ?? EMPTY_AGENT_CMD_OVERRIDES
  )
  const agentDetectionTargetKey = useAppStore((s): string | undefined => {
    const allWorktrees = Object.values(s.worktreesByRepo ?? {}).flat()
    const worktree = allWorktrees.find((w) => w.id === worktreeId)
    if (!worktree) {
      return undefined
    }
    const repo = s.repos?.find((r) => r.id === worktree.repoId)
    const repoConnectionId = repo?.connectionId?.trim()
    if (repoConnectionId) {
      return `ssh:${repoConnectionId}`
    }
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(s, worktreeId)?.trim()
    if (runtimeEnvironmentId) {
      return `runtime:${runtimeEnvironmentId}`
    }
    return AGENT_DETECTION_LOCAL_TARGET_KEY
  })
  const agentDetectionTarget = useMemo<AgentDetectionTarget | undefined>(() => {
    if (agentDetectionTargetKey === undefined) {
      return undefined
    }
    if (agentDetectionTargetKey === AGENT_DETECTION_LOCAL_TARGET_KEY) {
      return { kind: 'local' }
    }
    if (agentDetectionTargetKey.startsWith('ssh:')) {
      return { kind: 'ssh', connectionId: agentDetectionTargetKey.slice('ssh:'.length) }
    }
    if (agentDetectionTargetKey.startsWith('runtime:')) {
      return { kind: 'runtime', environmentId: agentDetectionTargetKey.slice('runtime:'.length) }
    }
    return { kind: 'local' }
  }, [agentDetectionTargetKey])
  const { detectedIds } = useDetectedAgents(agentDetectionTarget)
  const agentLaunchOptions = useMemo(
    () =>
      buildTabAgentLaunchOptions(
        orderTabLaunchAgents(defaultAgent, detectedIds ?? []),
        agentCmdOverrides
      ),
    [agentCmdOverrides, defaultAgent, detectedIds]
  )
  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  const windowsTerminalCapabilityOwnerKey = getWindowsTerminalCapabilityOwnerKey(
    activeRuntimeEnvironmentId,
    worktreeConnectionId
  )
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )
  const shouldProbeWindowsShellCapabilities =
    isWindows ||
    Boolean(activeRuntimeEnvironmentId?.trim()) ||
    isWebClient ||
    Boolean(worktreeConnectionId)
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldProbeWindowsShellCapabilities,
    false,
    windowsTerminalCapabilityOwnerKey,
    runtimeTarget,
    worktreeConnectionId
  )
  const shellMenuHostPlatform = worktreeConnectionId
    ? (worktreeRemotePlatform ?? windowsTerminalCapabilities.hostPlatform)
    : windowsTerminalCapabilities.hostPlatform
  const showWindowsShellMenu = shouldShowWindowsShellMenu({
    activeRuntimeEnvironmentId,
    hostPlatform: shellMenuHostPlatform,
    isWindowsClient: isWindows,
    worktreeHasRemoteConnection: Boolean(worktreeConnectionId)
  })
  const localProjectRuntime = useMemo(() => {
    if (!showWindowsShellMenu || activeRuntimeEnvironmentId?.trim() || worktreeConnectionId) {
      return undefined
    }
    return getLocalProjectExecutionRuntimeContext(
      {
        activeRepoId,
        activeWorktreeId,
        projects,
        repos,
        settings,
        worktreesByRepo
      },
      worktreeId,
      'win32',
      {
        wslAvailable: windowsTerminalCapabilities.isLoading
          ? undefined
          : windowsTerminalCapabilities.wslAvailable,
        availableWslDistros: windowsTerminalCapabilities.isLoading
          ? null
          : windowsTerminalCapabilities.wslDistros
      }
    )
  }, [
    activeRepoId,
    activeRuntimeEnvironmentId,
    activeWorktreeId,
    projects,
    repos,
    settings,
    showWindowsShellMenu,
    worktreeConnectionId,
    windowsTerminalCapabilities.isLoading,
    windowsTerminalCapabilities.wslAvailable,
    windowsTerminalCapabilities.wslDistros,
    worktreeId,
    worktreesByRepo
  ])
  const projectRuntimeShellMenuMode = getProjectRuntimeShellMenuMode(localProjectRuntime)
  const resolvedGroupId = groupId ?? activeGroupIdForWorktree ?? worktreeId

  const statusByRelativePath = useMemo(() => buildStatusMap(gitStatusEntries), [gitStatusEntries])
  const unifiedTabByVisibleId = useMemo(
    () => createUnifiedTabLookup(unifiedTabs, resolvedGroupId),
    [resolvedGroupId, unifiedTabs]
  )
  const workspaceHasSimulatorTab = useMemo(
    () => unifiedTabs.some((tab) => tab.contentType === 'simulator'),
    [unifiedTabs]
  )

  // Why: Electron <webview> elements run in a separate process, so clicking
  // inside one never dispatches a pointerdown on the renderer document.
  // Radix DropdownMenu relies on document pointerdown to detect outside
  // clicks, so it misses webview clicks entirely. Listening for window blur
  // catches the moment focus leaves the renderer (including into a webview).
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [createMenuQuery, setCreateMenuQuery] = useState('')
  const pendingNewTabMenuFocusRef = useRef<(() => void) | null>(null)
  const pendingNewTabMenuFocusAnimationRef = useRef<number | null>(null)
  const pendingNewTabMenuFocusRetryRef = useRef<number | null>(null)
  const clearPendingNewTabMenuFocusAnimation = (): void => {
    if (pendingNewTabMenuFocusAnimationRef.current === null) {
      return
    }
    cancelAnimationFrame(pendingNewTabMenuFocusAnimationRef.current)
    pendingNewTabMenuFocusAnimationRef.current = null
  }
  const clearPendingNewTabMenuFocusRetry = (): void => {
    if (pendingNewTabMenuFocusRetryRef.current === null) {
      return
    }
    window.clearTimeout(pendingNewTabMenuFocusRetryRef.current)
    pendingNewTabMenuFocusRetryRef.current = null
  }
  const focusNewActiveTerminalWhenReady = (
    previousActiveTabId: string | null,
    expiresAt: number
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
    if (Date.now() >= expiresAt) {
      return
    }
    pendingNewTabMenuFocusRetryRef.current = window.setTimeout(() => {
      pendingNewTabMenuFocusRetryRef.current = null
      focusNewActiveTerminalWhenReady(previousActiveTabId, expiresAt)
    }, NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS)
  }
  const queueNewActiveTerminalFocusAfterNewTabMenuClose = (): void => {
    const previousActiveTabId = useAppStore.getState().activeTabId
    pendingNewTabMenuFocusRef.current = () => {
      // Why: paired web/SSH runtime tab creation is async; wait for the host
      // snapshot to publish the newly active terminal instead of focusing the
      // pre-existing active tab.
      focusNewActiveTerminalWhenReady(
        previousActiveTabId,
        Date.now() + NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS
      )
    }
  }
  const queueTerminalTabFocusAfterNewTabMenuClose = (tabId: string): void => {
    pendingNewTabMenuFocusRef.current = () => focusTerminalTabSurface(tabId)
  }
  const windowsShellEntries = useMemo(() => {
    if (!showWindowsShellMenu || !onNewTerminalWithShell) {
      return undefined
    }
    const includeHostShells = projectRuntimeShellMenuMode !== 'wsl'
    const includeWslShell = projectRuntimeShellMenuMode !== 'host'
    const allShells: {
      label: string
      shell: BuiltInWindowsTerminalShell
    }[] = []
    if (includeHostShells) {
      allShells.push(
        {
          label: translate('auto.components.tab.bar.TabBar.2148f65e04', 'PowerShell'),
          shell: 'powershell.exe'
        },
        {
          label: translate('auto.components.tab.bar.TabBar.1a8af49530', 'CMD Prompt'),
          shell: 'cmd.exe'
        }
      )
      if (windowsTerminalCapabilities.gitBashAvailable) {
        allShells.push({
          label: translate('auto.components.tab.bar.TabBar.efb33546ff', 'Git Bash'),
          shell: WINDOWS_GIT_BASH_SHELL
        })
      }
    }
    if (includeWslShell && windowsTerminalCapabilities.wslAvailable) {
      allShells.push({
        label: translate('auto.components.tab.bar.TabBar.d1afac112b', 'WSL'),
        shell: 'wsl.exe'
      })
    }
    if (allShells.length === 0) {
      return undefined
    }
    const defaultEntry =
      allShells.find((shell) => shell.shell === defaultWindowsShell) ?? allShells[0]
    const orderedShells = [
      defaultEntry,
      ...allShells.filter((shell) => shell.shell !== defaultEntry.shell)
    ]
    return orderedShells.map((entry) => ({ label: entry.label, shell: entry.shell }))
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
        hasNewBrowser: !terminalOnly,
        hasNewMarkdown: !terminalOnly && Boolean(onNewFileTab),
        hasOpenMarkdown: !terminalOnly && Boolean(onOpenFileTab),
        hasSimulator:
          !terminalOnly && isMacOs && mobileEmulatorEnabled && Boolean(onNewSimulatorTab),
        simulatorIsGoTo: workspaceHasSimulatorTab
      }),
    [
      mobileEmulatorEnabled,
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
        break
    }
  }
  const launchAgentFromNewTabEntry = (agent: TuiAgent): void => {
    const option = agentLaunchOptions.find((candidate) => candidate.agent === agent)
    const result = launchAgentInNewTab({
      agent,
      worktreeId,
      groupId: resolvedGroupId,
      launchSource: 'tab_bar_quick_launch'
    })
    if (!result) {
      toast.error(
        translate(
          'auto.components.tab.bar.TabBar.ab589350e5',
          'Could not build launch command for {{value0}}.',
          { value0: option?.label ?? agent }
        )
      )
      return
    }
    if (result.tabId) {
      queueTerminalTabFocusAfterNewTabMenuClose(result.tabId)
      return
    }
    queueNewActiveTerminalFocusAfterNewTabMenuClose()
  }
  const runPendingNewTabMenuFocusAfterClose = (): void => {
    const pendingFocus = pendingNewTabMenuFocusRef.current
    pendingNewTabMenuFocusRef.current = null
    clearPendingNewTabMenuFocusAnimation()
    clearPendingNewTabMenuFocusRetry()
    if (pendingFocus) {
      pendingNewTabMenuFocusAnimationRef.current = requestAnimationFrame(() => {
        pendingNewTabMenuFocusAnimationRef.current = null
        pendingFocus()
      })
    }
  }

  const clearPendingNewTabMenuFocusOnUnmountRef = useRef<
    ((node: HTMLDivElement | null) => void) | null
  >(null)
  if (clearPendingNewTabMenuFocusOnUnmountRef.current === null) {
    clearPendingNewTabMenuFocusOnUnmountRef.current = (node: HTMLDivElement | null): void => {
      if (node !== null) {
        return
      }
      // Why: the delayed focus handoff is scoped to this tab bar instance.
      // A root ref cleanup cancels it at the DOM owner boundary without an
      // otherwise cleanup-only React Effect.
      clearPendingNewTabMenuFocusAnimation()
      clearPendingNewTabMenuFocusRetry()
    }
  }
  const clearPendingNewTabMenuFocusOnUnmount = clearPendingNewTabMenuFocusOnUnmountRef.current

  const defaultTerminalMenuItems =
    windowsShellEntries && onNewTerminalWithShell ? (
      windowsShellEntries.map((entry, idx) => {
        const isDefault = idx === 0
        return (
          <DropdownMenuItem
            key={entry.shell}
            onSelect={() => {
              // Why: the top-level Windows shell menu models shell
              // categories, not concrete executables. When the user
              // picked PowerShell 7+ in advanced settings, launching the
              // "PowerShell" menu item must preserve that implementation
              // instead of forcing inbox powershell.exe.
              queueNewActiveTerminalFocusAfterNewTabMenuClose()
              onNewTerminalWithShell(
                resolveWindowsShellLaunchTarget(
                  entry.shell,
                  defaultWindowsPowerShellImplementation,
                  windowsTerminalCapabilities.pwshAvailable
                )
              )
            }}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          >
            <ShellIcon shell={entry.shell} size={14} />
            <span className="flex-1">
              {translate('auto.components.tab.bar.TabBar.7c1313d237', 'New Terminal:')}{' '}
              {entry.label}
            </span>
            {isDefault ? <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        )
      })
    ) : (
      <DropdownMenuItem
        onSelect={() => {
          queueNewActiveTerminalFocusAfterNewTabMenuClose()
          onNewTerminalTab()
        }}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <TerminalSquare className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')}
        <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    )
  const newBrowserMenuItem = !terminalOnly ? (
    <DropdownMenuItem
      onSelect={onNewBrowserTab}
      className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      <Globe className="size-4 text-muted-foreground" />
      {translate('auto.components.tab.bar.TabBar.4833fb2cbe', 'New Browser Tab')}
      <DropdownMenuShortcut>{newBrowserShortcut}</DropdownMenuShortcut>
    </DropdownMenuItem>
  ) : null
  const newSimulatorMenuItem =
    !terminalOnly && isMacOs && mobileEmulatorEnabled && onNewSimulatorTab ? (
      workspaceHasSimulatorTab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem
              onSelect={onNewSimulatorTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <Smartphone className="size-4 text-muted-foreground" />
              {translate('auto.components.tab.bar.TabBar.b426bb2615', 'Go to Mobile Emulator')}
              <DropdownMenuShortcut>{newSimulatorShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="z-[80]">
            {translate(
              'auto.components.tab.bar.TabBar.aea43b5748',
              'Open the existing emulator tab.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuItem
          onSelect={onNewSimulatorTab}
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
        >
          <Smartphone className="size-4 text-muted-foreground" />
          {translate('auto.components.tab.bar.TabBar.fd2b42aaa3', 'New Mobile Emulator')}
          <DropdownMenuShortcut>{newSimulatorShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )
    ) : null
  const newMarkdownMenuItem =
    !terminalOnly && onNewFileTab ? (
      <DropdownMenuItem
        onSelect={onNewFileTab}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <FilePlus className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.3d5d6c960d', 'New Markdown')}
        <DropdownMenuShortcut>{newFileShortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    ) : null
  const openMarkdownMenuItem =
    !terminalOnly && onOpenFileTab ? (
      <DropdownMenuItem
        onSelect={onOpenFileTab}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <FileText className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.4f327c8b3d', 'Open Markdown...')}
        {openMarkdownShortcut ? (
          <DropdownMenuShortcut>{openMarkdownShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    ) : null
  const mobileEmulatorIntroMenuBlock =
    showMobileEmulatorIntroCallout &&
    !terminalOnly &&
    isMacOs &&
    mobileEmulatorEnabled &&
    onNewSimulatorTab ? (
      <MobileEmulatorTabIntroCallout />
    ) : null
  const standardCreateMenuItems =
    newTabMenuOrder === 'markdown-first' ? (
      <>
        {newMarkdownMenuItem}
        {openMarkdownMenuItem}
        {defaultTerminalMenuItems}
        {newBrowserMenuItem}
        {newSimulatorMenuItem}
        {mobileEmulatorIntroMenuBlock}
      </>
    ) : (
      <>
        {defaultTerminalMenuItems}
        {newBrowserMenuItem}
        {newMarkdownMenuItem}
        {openMarkdownMenuItem}
        {newSimulatorMenuItem}
        {mobileEmulatorIntroMenuBlock}
      </>
    )

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

  const showStaticCreateMenuItems = createMenuQuery.trim().length === 0

  const terminalMap = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  const editorMap = useMemo(
    () => new Map((editorFiles ?? []).map((f) => [f.tabId ?? f.id, f])),
    [editorFiles]
  )
  const browserMap = useMemo(
    () => new Map((browserTabs ?? []).map((t) => [t.id, t])),
    [browserTabs]
  )

  const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const editorFileIds = useMemo(() => editorFiles?.map((f) => f.tabId ?? f.id) ?? [], [editorFiles])
  const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs])
  const simulatorTabIds = useMemo(
    () =>
      (unifiedTabs ?? [])
        .filter((t) => t.groupId === resolvedGroupId && t.contentType === 'simulator')
        .map((t) => t.id),
    [unifiedTabs, resolvedGroupId]
  )

  // Build the unified ordered list, reconciling stored order with current items
  const orderedItems = useMemo(() => {
    const ids = reconcileTabOrder(
      tabBarOrder,
      terminalIds,
      editorFileIds,
      browserTabIds,
      simulatorTabIds
    )
    const items: TabItem[] = []
    for (const id of ids) {
      const terminal = terminalMap.get(id)
      if (terminal) {
        const unifiedTab = unifiedTabByVisibleId.get(id)
        items.push({
          type: 'terminal',
          id,
          unifiedTabId: terminal.unifiedTabId ?? unifiedTab?.id ?? terminal.id,
          isPinned: unifiedTab?.isPinned === true,
          data: terminal
        })
        continue
      }
      const file = editorMap.get(id)
      if (file) {
        const unifiedTab = unifiedTabByVisibleId.get(id) ?? unifiedTabByVisibleId.get(file.id)
        items.push({
          type: 'editor',
          id,
          unifiedTabId: file.tabId ?? unifiedTab?.id ?? file.id,
          isPinned: unifiedTab?.isPinned === true,
          data: file
        })
        continue
      }
      const browserTab = browserMap.get(id)
      if (browserTab) {
        const unifiedTab = unifiedTabByVisibleId.get(id)
        items.push({
          type: 'browser',
          id,
          unifiedTabId: browserTab.tabId ?? unifiedTab?.id ?? browserTab.id,
          isPinned: unifiedTab?.isPinned === true,
          data: browserTab
        })
        continue
      }
      const simUnified = unifiedTabByVisibleId.get(id)
      if (simUnified && simUnified.contentType === 'simulator') {
        items.push({
          type: 'simulator',
          id,
          unifiedTabId: simUnified.id,
          isPinned: simUnified.isPinned === true,
          data: simUnified
        })
        continue
      }
    }
    return items
  }, [
    tabBarOrder,
    terminalIds,
    editorFileIds,
    browserTabIds,
    simulatorTabIds,
    terminalMap,
    editorMap,
    browserMap,
    unifiedTabByVisibleId
  ])

  const sortableIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems])

  const activeIndicator =
    hoveredTabInsertion?.groupId === resolvedGroupId ? hoveredTabInsertion : null
  const dropIndicatorByVisibleId = useMemo(() => {
    const indicators = new Map<string, DropIndicator>()
    for (const edge of resolveTabIndicatorEdges(
      orderedItems.map((item) => item.id),
      activeIndicator
    )) {
      indicators.set(edge.visibleTabId, edge.side)
    }
    return indicators
  }, [activeIndicator, orderedItems])

  const activeVisibleTabId = useMemo(() => {
    const activeItem = orderedItems.find((item) => {
      if (item.type === 'terminal') {
        return (
          (activeTabType === 'terminal' || activeTabType === 'simulator') && item.id === activeTabId
        )
      }
      if (item.type === 'browser') {
        return activeTabType === 'browser' && item.id === activeBrowserTabId
      }
      if (item.type === 'simulator') {
        return activeTabType === 'simulator' && item.id === activeSimulatorTabId
      }
      return (
        (activeTabType === 'editor' || activeTabType === 'simulator') && activeFileId === item.id
      )
    })
    return activeItem?.id ?? null
  }, [
    activeBrowserTabId,
    activeFileId,
    activeSimulatorTabId,
    activeTabId,
    activeTabType,
    orderedItems
  ])
  const tabStripLayoutKey = useMemo(
    () =>
      orderedItems
        .map((item) =>
          getTabLayoutSignature(item, {
            generatedTitlesEnabled: generatedTabTitlesEnabled,
            isExpanded: expandedPaneByTabId[item.id] === true,
            status:
              item.type === 'editor'
                ? (statusByRelativePath.get(normalizeRelativePath(item.data.relativePath)) ?? null)
                : null
          })
        )
        .join('\u001f'),
    [expandedPaneByTabId, generatedTabTitlesEnabled, orderedItems, statusByRelativePath]
  )

  const togglePinned = (item: TabItem): void => {
    // pinTab/unpinTab mirror the change to the host for remote-server tabs.
    if (item.isPinned) {
      unpinTab(item.unifiedTabId)
      return
    }
    if (item.type === 'editor' && onPinFile) {
      onPinFile(item.data.id, item.unifiedTabId)
      return
    }
    pinTab(item.unifiedTabId)
  }

  const { tabStripRef, tabStripOverflowState, scrollTabStrip } = useTabStripOverflowNavigation({
    activeVisibleTabId,
    layoutKey: tabStripLayoutKey,
    tabCount: orderedItems.length,
    worktreeId
  })
  const tabStripDragScroll = useTabStripDragScrollHandlers(scrollTabStrip, {
    start: tabStripOverflowState.canScrollStart,
    end: tabStripOverflowState.canScrollEnd
  })

  return (
    <div
      ref={clearPendingNewTabMenuFocusOnUnmount}
      className="flex items-stretch h-full overflow-hidden flex-1 min-w-0"
      // Why: only drops aimed at the top tab/session strip should open files in
      // Orca's editor. Terminal-pane drops need to keep inserting file paths
      // into the active coding CLI, so preload routes native OS drops based on
      // this explicit surface marker instead of treating the whole app as an
      // editor drop zone.
      data-native-file-drop-target="editor"
    >
      {tabStripOverflowState.hasOverflow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 my-auto h-6 w-5 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-35"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              aria-label={translate(
                'auto.components.tab.bar.TabBar.7a9b4af2af',
                'Scroll tabs left'
              )}
              aria-disabled={!tabStripOverflowState.canScrollStart}
              disabled={
                !tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollStart
              }
              onClick={() => scrollTabStrip('start')}
              onPointerEnter={tabStripDragScroll.onDragScrollStartEnter}
              onPointerLeave={tabStripDragScroll.onDragScrollLeave}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.tab.bar.TabBar.7a9b4af2af', 'Scroll tabs left')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Why: no strategy means dnd-kit does not animate siblings aside for
          the active tab. Combined with dropping transform/transition on the
          dragged tab (see SortableTab etc.), this keeps every tab visually
          anchored during a drag so only the blue insertion bar moves. */}
      <SortableContext items={sortableIds}>
        {/* Why: no-drag lets tab interactions work inside the titlebar's drag
            region. The outer container inherits drag so empty space after the
            "+" button remains window-draggable. */}
        <div
          className="relative flex min-h-0 min-w-0 max-w-full flex-[0_1_auto]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div
            ref={tabStripRef}
            // Why: only `border-r` on the strip — the trailing edge must stay
            // visible even when tabs overflow-scroll past the last tab. The
            // left edge is instead painted by the FIRST tab's own `border-l`
            // (see per-tab components) so its rendering is identical to every
            // between-tab separator. A strip-level `border-l` would render at
            // a different box than the tab's own `border-t`, producing a
            // heavier-looking L-corner at the leftmost tab when inactive.
            className={[
              'terminal-tab-strip flex h-full min-w-0 max-w-full flex-1 items-stretch overflow-x-auto overflow-y-hidden border-r border-border/70',
              getTabStripScrollMaskClassName(tabStripOverflowState)
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {orderedItems.map((item, index) => {
              const dragData: TabDragItemData = {
                kind: 'tab',
                worktreeId,
                groupId: resolvedGroupId,
                unifiedTabId: item.unifiedTabId,
                visibleTabId: item.id,
                tabType: item.type,
                label: getTabDragLabel(item, generatedTabTitlesEnabled),
                iconPath: item.type === 'editor' ? item.data.filePath : undefined,
                color: item.type === 'terminal' ? (item.data.color ?? null) : null
              }
              if (item.type === 'terminal') {
                const terminalTab = {
                  ...item.data,
                  title: resolveTerminalTabTitle(
                    item.data,
                    generatedTabTitlesEnabled,
                    item.data.title
                  )
                }
                return (
                  <SortableTab
                    key={item.id}
                    tab={terminalTab}
                    unifiedTabId={item.unifiedTabId}
                    groupId={resolvedGroupId}
                    tabCount={orderedItems.length}
                    hasTabsToRight={index < orderedItems.length - 1}
                    isActive={
                      (activeTabType === 'terminal' || activeTabType === 'simulator') &&
                      item.id === activeTabId
                    }
                    isPinned={item.isPinned}
                    isExpanded={expandedPaneByTabId[item.id] === true}
                    onActivate={onActivate}
                    onClose={onClose}
                    onCloseOthers={onCloseOthers}
                    onCloseToRight={onCloseToRight}
                    onSetCustomTitle={onSetCustomTitle}
                    onSetTabColor={onSetTabColor}
                    onTogglePin={() => togglePinned(item)}
                    onToggleExpand={onTogglePaneExpand}
                    dragData={dragData}
                    dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                    includeTopTabBorder={includeTopTabBorder}
                  />
                )
              }
              if (item.type === 'browser') {
                return (
                  <BrowserTab
                    key={item.id}
                    tab={item.data}
                    isActive={activeTabType === 'browser' && activeBrowserTabId === item.id}
                    isPinned={item.isPinned}
                    hasTabsToRight={index < orderedItems.length - 1}
                    onActivate={() => onActivateBrowserTab?.(item.id)}
                    onClose={() => onCloseBrowserTab?.(item.id)}
                    onCloseToRight={() => onCloseToRight(item.id)}
                    onDuplicate={() => onDuplicateBrowserTab?.(item.id)}
                    onTogglePin={() => togglePinned(item)}
                    dragData={dragData}
                    dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                    includeTopTabBorder={includeTopTabBorder}
                  />
                )
              }
              if (item.type === 'simulator') {
                const simLabel = item.data.label || 'Mobile Emulator'
                const simFile: OpenFile & { tabId: string } = {
                  id: item.id,
                  tabId: item.id,
                  filePath: simLabel,
                  relativePath: simLabel,
                  worktreeId,
                  language: 'simulator',
                  isPreview: false,
                  isDirty: false,
                  mode: 'edit'
                }
                return (
                  <EditorFileTab
                    key={item.id}
                    file={simFile}
                    isActive={activeTabType === 'simulator' && item.id === activeSimulatorTabId}
                    isPinned={item.isPinned}
                    hasTabsToRight={index < orderedItems.length - 1}
                    statusByRelativePath={statusByRelativePath}
                    onActivate={() => onActivateFile?.(item.id)}
                    onClose={() => onCloseFile?.(item.id)}
                    onCloseToRight={() => onCloseToRight(item.id)}
                    onCloseAll={() => onCloseAllFiles?.()}
                    onMakePermanent={() => {}}
                    onTogglePin={() => togglePinned(item)}
                    dragData={dragData}
                    dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                    includeTopTabBorder={includeTopTabBorder}
                  />
                )
              }
              return (
                <EditorFileTab
                  key={item.id}
                  file={item.data}
                  isActive={
                    (activeTabType === 'editor' || activeTabType === 'simulator') &&
                    activeFileId === item.id
                  }
                  isPinned={item.isPinned}
                  hasTabsToRight={index < orderedItems.length - 1}
                  statusByRelativePath={statusByRelativePath}
                  onActivate={() => onActivateFile?.(item.id)}
                  onClose={() => onCloseFile?.(item.id)}
                  onCloseToRight={() => onCloseToRight(item.id)}
                  onCloseAll={() => onCloseAllFiles?.()}
                  onMakePermanent={() =>
                    onMakePreviewFilePermanent?.(item.data.id, item.data.tabId)
                  }
                  onTogglePin={() => togglePinned(item)}
                  dragData={dragData}
                  dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                  includeTopTabBorder={includeTopTabBorder}
                />
              )
            })}
          </div>
          <TabStripScrollIndicator metrics={tabStripOverflowState} />
        </div>
      </SortableContext>
      {tabStripOverflowState.hasOverflow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 my-auto h-6 w-5 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-35"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              aria-label={translate(
                'auto.components.tab.bar.TabBar.232e075b07',
                'Scroll tabs right'
              )}
              aria-disabled={!tabStripOverflowState.canScrollEnd}
              disabled={!tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollEnd}
              onClick={() => scrollTabStrip('end')}
              onPointerEnter={tabStripDragScroll.onDragScrollEndEnter}
              onPointerLeave={tabStripDragScroll.onDragScrollLeave}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu
        open={newTabMenuOpen}
        onOpenChange={setNewTabMenuOpen}
        // Why: this menu can stay open after the Mobile Emulator "Hide" action,
        // which shows a toast with a re-enable link; modal would disable body
        // pointer events and make that toast (and other outside UI) unclickable.
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            className="ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
            // Why: aria-label matches the tooltip so E2E can locate the "+"
            // affordance via getByRole('button', { name: 'New tab' }). The
            // store-only createTab() round-trip that preceded this was a
            // tautology — it would pass even if the + button had been deleted.
            aria-label={translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
          onCloseAutoFocus={(e) => {
            // Why: terminal-producing menu actions activate a freshly-mounted
            // xterm. Radix's default focus restore sends focus back to the "+"
            // trigger after close, stealing it from the new terminal.
            e.preventDefault()
            runPendingNewTabMenuFocusAfterClose()
          }}
        >
          {!terminalOnly && onOpenEntry ? (
            <>
              <TabBarCreateEntry
                worktreeId={worktreeId}
                groupId={resolvedGroupId}
                menuOpen={newTabMenuOpen}
                menuOptions={createMenuOptions}
                agentOptions={agentLaunchOptions}
                onLaunchAgent={launchAgentFromNewTabEntry}
                onOpenDefaultTerminal={() => {
                  queueNewActiveTerminalFocusAfterNewTabMenuClose()
                  onNewTerminalTab()
                }}
                onOpenEntry={onOpenEntry}
                onQueryChange={setCreateMenuQuery}
                onSelectMenuOption={handleSelectCreateMenuOption}
                onDidOpenEntry={() => setNewTabMenuOpen(false)}
              />
              {showStaticCreateMenuItems ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {showStaticCreateMenuItems ? standardCreateMenuItems : null}
          {showStaticCreateMenuItems && showAgentLaunchItems ? (
            <>
              <DropdownMenuSeparator />
              <QuickLaunchAgentMenuItems
                worktreeId={worktreeId}
                groupId={resolvedGroupId}
                onFocusTerminal={queueTerminalTabFocusAfterNewTabMenuClose}
              />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default React.memo(TabBarInner)
