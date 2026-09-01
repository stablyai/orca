import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GitFileStatus, GlobalSettings, Tab, TuiAgent } from '../../../../shared/types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { toLegacyAutoPreference } from '../../../../shared/tui-agent-selection'
import { useAppStore } from '../../store'
import { buildStatusMap } from '../right-sidebar/status-display'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useLocalAgentCatalog } from '@/hooks/useLocalAgentCatalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useOptionalShortcutLabel, useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities,
  type WindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { shouldShowMobileEmulatorTabIntro } from '../emulator-pane/mobile-emulator-tab-intro-visibility'
import {
  selectTabBarAgentProjections,
  type TabBarAgentProjections
} from './tab-agent-types-by-tab-id'
import {
  buildTabAgentLaunchOptions,
  deriveTabCustomAgentEntries,
  orderTabLaunchAgents
} from './tab-agent-launch-options'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import { shouldShowWindowsShellMenu } from './windows-shell-menu-visibility'
import { createUnifiedTabLookup } from './tab-bar-item-model'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'

const isWindows = navigator.userAgent.includes('Windows')
export const isMacOs = navigator.userAgent.includes('Mac')
type AppStoreState = ReturnType<typeof useAppStore.getState>
type GitStatusEntries = AppStoreState['gitStatusByWorktree'][string]
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntries = []
const EMPTY_AGENT_CMD_OVERRIDES: Partial<Record<TuiAgent, string>> = {}
const EMPTY_DISABLED_TUI_AGENTS: readonly TuiAgent[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []

export function getProjectRuntimeShellMenuMode(
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

export function resolveWindowsPowerShellImplementationSetting(settings: GlobalSettings | null) {
  return settings?.terminalWindowsPowerShellImplementation ?? 'auto'
}

export type TabBarRuntimeModel = {
  newTerminalShortcut: string
  newBrowserShortcut: string
  newSimulatorShortcut: string
  newFileShortcut: string
  openMarkdownShortcut: string | null
  generatedTabTitlesEnabled: boolean
  mobileEmulatorEnabled: boolean
  showMobileEmulatorIntroCallout: boolean
  unifiedTabs: readonly Tab[]
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  defaultWindowsShell: string
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
  agentLaunchOptions: TabAgentLaunchOption[]
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  resolvedGroupId: string
  statusByRelativePath: Map<string, GitFileStatus>
  unifiedTabByVisibleId: Map<string, Tab>
  workspaceHasSimulatorTab: boolean
  toggleTabViewMode: (tabId: string) => void
  nativeChatTranscriptIsLocalReadable: boolean
  customTuiAgents: GlobalSettings['customTuiAgents']
  deletedCustomTuiAgents: GlobalSettings['deletedCustomTuiAgents']
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
} & TabBarAgentProjections

export function useTabBarRuntimeModel({
  worktreeId,
  groupId
}: {
  worktreeId: string
  groupId?: string
}): TabBarRuntimeModel {
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
  const defaultWindowsPowerShellImplementation = useAppStore((s) =>
    resolveWindowsPowerShellImplementationSetting(s.settings)
  )
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const projects = useAppStore((s) => s.projects)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  // Why: use the worktree's owning host so offered Windows shells match the host that actually runs the terminal.
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => getRuntimeEnvironmentIdForWorktree(s, worktreeId)?.trim() || null
  )
  // Why: retained tab strips rerun selectors on every store write; reuse canonical indexes, don't flatten both slices here.
  const worktreeConnectionId = useAppStore(
    (s) => getConnectionIdFromState(s, worktreeId)?.trim() || null
  )
  const worktreeRemotePlatform = useAppStore((s) => {
    if (!worktreeConnectionId) {
      return null
    }
    return s.sshConnectionStates.get(worktreeConnectionId)?.remotePlatform ?? null
  })
  const defaultAgent = toLegacyAutoPreference(useAppStore((s) => s.settings?.defaultTuiAgent))
  const agentCmdOverrides = useAppStore(
    (s) => s.settings?.agentCmdOverrides ?? EMPTY_AGENT_CMD_OVERRIDES
  )
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const disabledTuiAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? EMPTY_DISABLED_TUI_AGENTS
  )
  const { snapshot: localAgentCatalog } = useLocalAgentCatalog()
  const { detectedIds } = useDetectedAgents(agentDetectionTarget)
  const agentLaunchOptions = useMemo(() => {
    const customs = deriveTabCustomAgentEntries(localAgentCatalog, disabledTuiAgents)
    return buildTabAgentLaunchOptions(
      orderTabLaunchAgents(defaultAgent, detectedIds ?? [], customs, disabledTuiAgents),
      agentCmdOverrides,
      customs
    )
  }, [agentCmdOverrides, defaultAgent, detectedIds, disabledTuiAgents, localAgentCatalog])
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
      { activeRepoId, activeWorktreeId, projects, repos, settings, worktreesByRepo },
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
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] = useAppStore(
    useShallow((state) => {
      const policy = getClientCreationActionPolicy(state, worktreeId)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    })
  )
  // Why: tab-wide launch/title hints are safe only before split; gate the view-mode toggle to the active leaf's agent.
  const toggleTabViewMode = useAppStore((s) => s.toggleTabViewMode)
  // Why: every retained TabBar observes the same hot maps; one feature-gated selector shares their projections.
  const { nativeChatEnabled, tabAgentTypesByTabId, nativeChatTabWideFallbackUnsafeTabsById } =
    useAppStore(useShallow(selectTabBarAgentProjections))
  const nativeChatTranscriptIsLocalReadable = useAppStore((s) =>
    isNativeChatTranscriptLocalReadable(getConnectionIdFromState(s, worktreeId))
  )

  return {
    newTerminalShortcut,
    newBrowserShortcut,
    newSimulatorShortcut,
    newFileShortcut,
    openMarkdownShortcut,
    generatedTabTitlesEnabled,
    mobileEmulatorEnabled,
    showMobileEmulatorIntroCallout,
    unifiedTabs,
    pinTab,
    unpinTab,
    defaultWindowsShell,
    defaultWindowsPowerShellImplementation,
    agentLaunchOptions,
    windowsTerminalCapabilities,
    showWindowsShellMenu,
    projectRuntimeShellMenuMode,
    resolvedGroupId,
    statusByRelativePath,
    unifiedTabByVisibleId,
    workspaceHasSimulatorTab,
    toggleTabViewMode,
    nativeChatEnabled,
    tabAgentTypesByTabId,
    nativeChatTabWideFallbackUnsafeTabsById,
    nativeChatTranscriptIsLocalReadable,
    // Custom agents reach native chat through their base harness, so the toggle gate needs the catalog.
    customTuiAgents: settings?.customTuiAgents,
    deletedCustomTuiAgents: settings?.deletedCustomTuiAgents,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled
  }
}
