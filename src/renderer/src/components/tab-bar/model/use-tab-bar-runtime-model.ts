import {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting
} from './tab-bar-windows-shell-settings'
import { getSimulatorTabForWorktree } from '@/lib/simulator/tabs/ensure-simulator-tab'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { shallow } from 'zustand/shallow'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store/index'
import { buildStatusMap } from '../../../../../shared/git/status/git-path-decoration'
import { useAgentDetectionTargetForWorktree } from '@/lib/agent-session/launch/inventory/useAgentDetectionTarget'
import {
  getConnectionIdFromState,
  getConnectionIdForWorktreeCopy
} from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { isNativeChatTranscriptLocalReadable } from '../../../../../shared/native-chat/transcript/messages/native-chat-transcript-readability'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import {
  isReturningToHeldWindowsTerminalCapabilities,
  holdWindowsTerminalCapabilitiesForReleasedStrip,
  takeWindowsTerminalCapabilityHold
} from '@/runtime/hosts/capabilities/windows-terminal-capability-holds'
import type { WindowsTerminalCapabilities } from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { shouldShowMobileEmulatorTabIntro } from '../../emulator-pane/tab-intro/mobile-emulator-tab-intro-visibility'
import { selectTabBarAgentProjections } from './tab-agent-types-by-tab-id'
import type { TabBarAgentProjections } from './tab-agent-types-by-tab-id'
import { shouldShowWindowsShellMenu } from '../create-menu/windows-shell-menu-visibility'
import { createUnifiedTabLookup } from './tab-bar-item-model'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { GitFileStatus } from '../../../../../shared/git/status/git-status-types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'

const isWindows = navigator.userAgent.includes('Windows')
export const isMacOs = navigator.userAgent.includes('Mac')
type AppStoreState = ReturnType<typeof useAppStore.getState>
type GitStatusEntries = AppStoreState['gitStatusByWorktree'][string]
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntries = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_PROJECTS: AppStoreState['projects'] = []
const EMPTY_REPOS: AppStoreState['repos'] = []
const EMPTY_WORKTREES_BY_REPO: AppStoreState['worktreesByRepo'] = {}

export type TabBarRuntimeModel = {
  generatedTabTitlesEnabled: boolean
  mobileEmulatorEnabled: boolean
  showMobileEmulatorIntroCallout: boolean
  unifiedTabs: readonly Tab[]
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  defaultWindowsShell: string
  agentDetectionTarget: AgentDetectionTarget | undefined
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  resolvedGroupId: string
  statusByRelativePath: Map<string, GitFileStatus>
  unifiedTabByVisibleId: Map<string, Tab>
  workspaceHasSimulatorTab: boolean
  toggleTabViewMode: (tabId: string) => void
  nativeChatTranscriptIsLocalReadable: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
} & TabBarAgentProjections

export function useTabBarRuntimeModel({
  worktreeId,
  groupId,
  executionHostId
}: {
  worktreeId: string
  groupId?: string
  executionHostId?: ExecutionHostId
}): TabBarRuntimeModel {
  const selectedHost = parseExecutionHostId(executionHostId)
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
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId, executionHostId)
  const defaultWindowsPowerShellImplementation = useAppStore((s) =>
    resolveWindowsPowerShellImplementationSetting(s.settings)
  )
  const settings = useAppStore((s) => s.settings)
  // Why: use the worktree's owning host so offered Windows shells match the host that actually runs the terminal.
  const ownerRuntimeEnvironmentId = useAppStore((s) => {
    if (!executionHostId) {
      return runtimeEnvironmentIdOrLocalUnlessTwin(s, worktreeId)
    }
    const owner = runtimeEnvironmentIdForWorkspaceOwner(s, {
      workspaceId: worktreeId,
      hostId: executionHostId
    })
    return owner.kind === 'resolved' ? owner.environmentId : null
  })
  // Why: retained tab strips rerun selectors on every store write; reuse canonical indexes, don't flatten both slices here.
  const worktreeConnectionId = useAppStore(
    (s) =>
      (executionHostId
        ? getConnectionIdForWorktreeCopy(s, worktreeId, executionHostId)
        : getConnectionIdFromState(s, worktreeId)
      )?.trim() || null
  )
  const worktreeRemotePlatform = useAppStore((s) => {
    if (!worktreeConnectionId) {
      return null
    }
    const connection = ownerRuntimeEnvironmentId
      ? s.sshStateByEnvironment
          .get(ownerRuntimeEnvironmentId)
          ?.connectionStates.get(worktreeConnectionId)
      : s.sshConnectionStates.get(worktreeConnectionId)
    return connection?.remotePlatform ?? null
  })
  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  const windowsTerminalCapabilityOwnerKey = getWindowsTerminalCapabilityOwnerKey(
    ownerRuntimeEnvironmentId,
    worktreeConnectionId
  )
  const runtimeTarget = useMemo(
    () => runtimeTargetForOwnerEnvironment(ownerRuntimeEnvironmentId),
    [ownerRuntimeEnvironmentId]
  )
  const shouldProbeWindowsShellCapabilities =
    isWindows ||
    Boolean(ownerRuntimeEnvironmentId?.trim()) ||
    isWebClient ||
    Boolean(worktreeConnectionId)
  const [returningStrip] = useState(
    // A different host on return (e.g. host-qualified activation) takes the normal TTL load.
    () =>
      groupId !== undefined &&
      isReturningToHeldWindowsTerminalCapabilities(
        worktreeId,
        groupId,
        windowsTerminalCapabilityOwnerKey
      )
  )
  useEffect(() => {
    if (!groupId) {
      return
    }
    // Runs after every dependency change too, so a hold the previous cleanup left for a still-mounted strip is dropped here.
    takeWindowsTerminalCapabilityHold(worktreeId, groupId)
    if (!shouldProbeWindowsShellCapabilities) {
      return
    }
    return () => {
      // Unmounting with the group still open means its workspace released the layout; keep the answer for the return.
      holdWindowsTerminalCapabilitiesForReleasedStrip(
        worktreeId,
        groupId,
        windowsTerminalCapabilityOwnerKey
      )
    }
  }, [groupId, worktreeId, shouldProbeWindowsShellCapabilities, windowsTerminalCapabilityOwnerKey])
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldProbeWindowsShellCapabilities,
    false,
    windowsTerminalCapabilityOwnerKey,
    runtimeTarget,
    worktreeConnectionId,
    returningStrip
  )
  const shellMenuHostPlatform = worktreeConnectionId
    ? (worktreeRemotePlatform ?? windowsTerminalCapabilities.hostPlatform)
    : selectedHost?.kind === 'ssh'
      ? null
      : windowsTerminalCapabilities.hostPlatform
  const showWindowsShellMenu = shouldShowWindowsShellMenu({
    ownerRuntimeEnvironmentId,
    hostPlatform: shellMenuHostPlatform,
    isWindowsClient: isWindows,
    worktreeHasRemoteConnection: Boolean(worktreeConnectionId) || selectedHost?.kind === 'ssh'
  })
  // Subscribe to project/worktree maps only for the local shell menu; their routine writes otherwise repaint every retained strip.
  const needsLocalProjectRuntime =
    showWindowsShellMenu && !ownerRuntimeEnvironmentId?.trim() && !worktreeConnectionId
  const projects = useAppStore((s) => (needsLocalProjectRuntime ? s.projects : EMPTY_PROJECTS))
  const repos = useAppStore((s) => (needsLocalProjectRuntime ? s.repos : EMPTY_REPOS))
  const worktreesByRepo = useAppStore((s) =>
    needsLocalProjectRuntime ? selectWorktreesByRepo(s) : EMPTY_WORKTREES_BY_REPO
  )
  // Gated like the maps above: every retained strip would otherwise re-render on each workspace switch.
  const activeRepoId = useAppStore((s) => (needsLocalProjectRuntime ? s.activeRepoId : null))
  const activeWorktreeId = useAppStore((s) =>
    needsLocalProjectRuntime ? s.activeWorktreeId : null
  )
  const localProjectRuntime = useMemo(() => {
    if (!needsLocalProjectRuntime) {
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
    activeWorktreeId,
    needsLocalProjectRuntime,
    projects,
    repos,
    settings,
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
  const workspaceHasSimulatorTab = useAppStore((state) =>
    executionHostId
      ? Boolean(getSimulatorTabForWorktree(worktreeId, executionHostId, state))
      : (state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS).some(
          (tab) => tab.contentType === 'simulator'
        )
  )
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] =
    useAppStoreWithHostStatuses((state, statuses) => {
      const policy = getWorkspaceClientCreationActionPolicy(
        state,
        worktreeId,
        statuses,
        executionHostId
      )
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    }, shallow)
  // Why: tab-wide launch/title hints are safe only before split; gate the view-mode toggle to the active leaf's agent.
  const toggleTabViewMode = useAppStore((s) => s.toggleTabViewMode)
  // Why: every retained TabBar observes the same hot maps; one selector shares their projections.
  const { tabAgentTypesByTabId, nativeChatTabWideFallbackUnsafeTabsById } = useAppStore(
    useShallow(selectTabBarAgentProjections)
  )
  const nativeChatTranscriptIsLocalReadable = useAppStore((s) =>
    isNativeChatTranscriptLocalReadable(getConnectionIdFromState(s, worktreeId))
  )

  return {
    generatedTabTitlesEnabled,
    mobileEmulatorEnabled,
    showMobileEmulatorIntroCallout,
    unifiedTabs,
    pinTab,
    unpinTab,
    defaultWindowsShell,
    agentDetectionTarget,
    defaultWindowsPowerShellImplementation,
    windowsTerminalCapabilities,
    showWindowsShellMenu,
    projectRuntimeShellMenuMode,
    resolvedGroupId,
    statusByRelativePath,
    unifiedTabByVisibleId,
    workspaceHasSimulatorTab,
    toggleTabViewMode,
    tabAgentTypesByTabId,
    nativeChatTabWideFallbackUnsafeTabsById,
    nativeChatTranscriptIsLocalReadable,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled
  }
}
