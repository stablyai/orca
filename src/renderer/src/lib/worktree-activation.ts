/* eslint-disable max-lines -- Why: worktree activation is a single ordered flow spanning startup, setup, issue commands, and default tabs; splitting it would obscure sequencing guarantees. */
import type {
  FolderWorkspace,
  GlobalSettings,
  SetupSplitDirection,
  Tab,
  TuiAgent,
  Worktree,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/types'
import type { EventProps } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { buildSetupRunnerCommand } from './setup-runner'
import { createSequencedSetupAgentCommands } from '../../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../../shared/setup-runner-command'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { CLIENT_PLATFORM } from './new-workspace'
import { tuiAgentToAgentKind } from './telemetry'
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  activateWebRuntimeSessionWorktree,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import {
  setWorktreeNavActivator,
  setWorktreeNavViewActivator
} from '@/store/slices/worktree-nav-history'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { queueHookCommandsForFirstWorktreeTab } from '@/lib/hook-command-delayed-delivery'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderWorkspaceActivationBlocked,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'
import { toast } from 'sonner'
import { initialAgentTabViewModeProps } from './native-chat-initial-view-mode'
import { getConnectionId } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { resolveNativeChatSessionOptionDefaults } from '../../../shared/native-chat-session-option-defaults'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

/** Startup command threaded onto a worktree's first terminal at activation. */
export type WorktreeStartupPayload = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  draftPrompt?: string
  startupCommandDelivery?: StartupCommandDelivery
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  sessionOptions?: Record<string, SessionOptionValue>
  telemetry?: AgentStartedTelemetry
}

// Why: accept either a main-generated runner script or a plain TaskPage command string, so callers needn't synthesize a runner file.
export type IssueCommandLaunch =
  | WorktreeSetupLaunch
  | { command: string; env?: Record<string, string> }

type WorktreeActivationStore = Partial<WorktreeRuntimeOwnerState> & {
  tabsByWorktree: Record<string, { id: string }[]>
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  createTab: (
    worktreeId: string,
    targetGroupId?: string,
    shellOverride?: string,
    options?: {
      pendingActivationSpawn?: boolean
      launchAgent?: TuiAgent
      recordInteraction?: boolean
      viewMode?: Tab['viewMode']
      activate?: boolean
    }
  ) => { id: string }
  setActiveTab: (tabId: string) => void
  setTabCustomTitle: (
    tabId: string,
    title: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabColor: (tabId: string, color: string | null) => void
  markDefaultTerminalTabsApplied: (worktreeId: string) => void
  reconcileWorktreeTabModel: (worktreeId: string) => { renderableTabCount: number }
  queueTabStartupCommand: (
    tabId: string,
    startup: {
      command: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      draftPrompt?: string
      initialAgentStatus?: { agent: TuiAgent; prompt: string }
      showSessionRestoredBanner?: boolean
      telemetry?: AgentStartedTelemetry
    }
  ) => void
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  ) => void
  queueTabIssueCommandSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
  queueTabInitialCwd: (tabId: string, cwd: string) => void
  settings?: Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'> | null
}

/**
 * Shared activation sequence used by the worktree palette and add-repo/worktree dialogs.
 * The caller passes only `worktreeId`; the helper derives `repoId` and returns early
 * without side effects if the worktree is not found (deleted between palette open and select).
 */
export type ActivateAndRevealResult = {
  /** Id of the primary terminal tab seeded with `opts.startup`, or null. Prefer this over
   *  `activeTabIdByWorktree`, which may point at another tab if setup/issue scripts opened their own. */
  primaryTabId: string | null
}

function ensureFolderWorkspaceInitialTerminal(
  folderWorkspace: FolderWorkspace,
  startup?: WorktreeStartupPayload
): string | null {
  const state = useAppStore.getState()
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    startup,
    undefined,
    undefined,
    undefined
  )
  return primaryTabId
}

export function activateAndRevealFolderWorkspace(
  folderWorkspaceId: string,
  opts?: {
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    startup?: WorktreeStartupPayload
    runtimeEnvironmentId?: string | null
  }
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  const folderWorkspace = state.folderWorkspaces.find(
    (workspace) => workspace.id === folderWorkspaceId
  )
  if (!folderWorkspace) {
    return false
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(state, folderWorkspaceKey(folderWorkspaceId))
  const pathStatus = state.getFreshFolderWorkspacePathStatus(
    {
      scope: 'folder-workspace',
      folderWorkspaceId
    },
    { runtimeEnvironmentId }
  )
  if (folderWorkspaceActivationBlocked(pathStatus)) {
    toast.error(getFolderWorkspacePathStatusTitle(pathStatus) ?? 'Cannot open folder workspace', {
      description: getFolderWorkspacePathStatusDescription(pathStatus) ?? folderWorkspace.folderPath
    })
    return false
  }

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  state.setActiveFolderWorkspace(folderWorkspaceId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  state.markWorktreeVisited(workspaceKey)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(workspaceKey)
  }
  resumeSleepingAgentSessionsForWorktree(workspaceKey)
  const primaryTabId = ensureFolderWorkspaceInitialTerminal(folderWorkspace, opts?.startup)

  if (opts?.sidebarRevealBehavior) {
    state.revealWorktreeInSidebar(workspaceKey, { behavior: opts.sidebarRevealBehavior })
  } else {
    state.revealWorktreeInSidebar(workspaceKey)
  }

  return { primaryTabId }
}

function buildCreatedAgentReopenStartup(worktree: Worktree): WorktreeStartupPayload | undefined {
  const agent = worktree.createdWithAgent
  if (!isTuiAgent(agent)) {
    return undefined
  }

  const state = useAppStore.getState()
  const repo = state.repos.find((entry) => entry.id === worktree.repoId)
  const launchPlatform = repo
    ? getAgentLaunchPlatformForRepo(
        repo,
        repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(state, worktree.id)
      )
    : CLIENT_PLATFORM

  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv),
    sessionOptions: resolveNativeChatSessionOptionDefaults(
      state.settings?.nativeChatSessionOptions,
      agent
    ),
    platform: launchPlatform,
    isRemote: repo ? repoIsRemote(repo) : false,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    return undefined
  }

  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  }
}

export function activateAndRevealWorktree(
  worktreeId: string,
  opts?: {
    startup?: WorktreeStartupPayload
    initialCwd?: string
    setup?: WorktreeSetupLaunch
    defaultTabs?: WorktreeDefaultTabsLaunch
    issueCommand?: IssueCommandLaunch
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    notifyHostRuntime?: boolean
    revealInSidebar?: boolean
  }
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  const wt = state.getKnownWorktreeById(worktreeId)
  if (!wt) {
    return false
  }
  const hasActivationWork = Boolean(
    opts?.startup || opts?.setup || opts?.defaultTabs || opts?.issueCommand
  )
  // Why: a plain reselect should still reveal the sidebar row but must not restamp focus recency or wake persistence.
  const isPlainAlreadyActiveTerminal =
    !hasActivationWork &&
    state.activeRepoId === wt.repoId &&
    state.activeWorktreeId === worktreeId &&
    state.activeView === 'terminal'

  // 1. Set activeRepoId if crossing repos
  if (wt.repoId !== state.activeRepoId) {
    state.setActiveRepo(wt.repoId)
  }

  // 2. Switch any non-terminal view back to terminal
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  // 3. Core activation: setActiveWorktree also restores per-worktree state, clears unread, bumps dead PTY generations, refreshes GitHub
  state.setActiveWorktree(worktreeId)
  const postActivationState = useAppStore.getState()
  const ownerRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(postActivationState, wt.id)
  if (opts?.notifyHostRuntime !== false && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)) {
    // Why: paired web clients own only local selection, so the desktop host publishes session surfaces without treating it as a nav command.
    void activateWebRuntimeSessionWorktree({
      worktreeId,
      environmentId: ownerRuntimeEnvironmentId,
      notifyDesktop: (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
    })
  }

  // Why: focus recency for Cmd+J ordering, distinct from recordWorktreeVisit/lastActivityAt; stamp before any later async step could throw. See docs/cmd-j-empty-query-ordering.md.
  if (!isPlainAlreadyActiveTerminal) {
    state.markWorktreeVisited(worktreeId)
  }

  // Why: skip re-recording for goBack/goForward history navigation — it moves the index instead of visiting anew (isNavigatingHistory).
  if (!isPlainAlreadyActiveTerminal && !state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }

  // Why: sleeping destroys the local PTY but preserves the provider session id, so waking should restore those CLI sessions automatically.
  resumeSleepingAgentSessionsForWorktree(worktreeId)

  // 4. Ensure a focusable surface exists for externally-created worktrees
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    worktreeId,
    opts?.startup ?? buildCreatedAgentReopenStartup(wt),
    opts?.setup,
    opts?.issueCommand,
    opts?.defaultTabs
  )
  if (primaryTabId && opts?.initialCwd) {
    useAppStore.getState().queueTabInitialCwd(primaryTabId, opts.initialCwd)
  }

  // 5. Clear sidebar filters hiding the target — reveal needs the card rendered, else it silently no-ops.
  if (state.filterRepoIds.length > 0 && !state.filterRepoIds.includes(wt.repoId)) {
    state.setFilterRepoIds([])
  }
  if (
    state.hideAutomationGeneratedWorkspaces &&
    wt.automationProvenance?.kind === 'created-by-automation'
  ) {
    state.setHideAutomationGeneratedWorkspaces(false)
  }

  // 6. Reveal in sidebar
  if (opts?.revealInSidebar !== false) {
    if (opts?.sidebarRevealBehavior) {
      state.revealWorktreeInSidebar(worktreeId, { behavior: opts.sidebarRevealBehavior })
    } else {
      state.revealWorktreeInSidebar(worktreeId)
    }
  }

  if (opts?.notifyHostRuntime !== false) {
    ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId)
  }

  return { primaryTabId }
}

export function ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId: string): void {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktree.id)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return
  }

  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
  if (hasLivePty) {
    return
  }

  const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
  if (hasMirroredHostTabs) {
    // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
    return
  }

  if (getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) > 0) {
    return
  }

  const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
  if (tabs.length > 0 && renderableTabCount === 0) {
    return
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return
  }

  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, so a woke workspace can have tab chrome but no surface.
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId: runtimeEnvironmentId,
    activate: true,
    selectWorktree: false
  }).finally(() => {
    endWebRuntimeWakeTerminalRespawn(worktreeId)
  })
}

export function ensureWorktreeHasInitialTerminal(
  store: WorktreeActivationStore,
  worktreeId: string,
  startup?: WorktreeStartupPayload,
  setup?: WorktreeSetupLaunch,
  issueCommand?: IssueCommandLaunch,
  defaultTabs?: WorktreeDefaultTabsLaunch,
  opts?: { activateCreatedTabs?: boolean }
): string | null {
  const { renderableTabCount } = store.reconcileWorktreeTabModel(worktreeId)
  // Why: creating a terminal just because the legacy terminal slice is empty gives editor/browser-only worktrees an unexpected extra tab.
  const ownerState =
    store.settings !== undefined || store.repos !== undefined || store.worktreesByRepo !== undefined
      ? store
      : useAppStore.getState()
  let sequencedStartup = startup
  let wrappedSetupCommandStr: string | undefined

  if (startup && setup?.waitForAgentStartup === true) {
    const platform = getSetupRunnerCommandPlatformForPath(
      setup.runnerScriptPath,
      navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
    )
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  // Why: web clients mirror the server's session tabs, so avoid spawning a duplicate host terminal before the mirror lands.
  if (isWebRuntimeSessionActive(getRuntimeEnvironmentIdForWorktree(ownerState, worktreeId))) {
    const existingTerminalTabId = store.tabsByWorktree[worktreeId]?.[0]?.id
    if (existingTerminalTabId && (setup || issueCommand)) {
      queueSetupAndIssueCommands(
        store,
        worktreeId,
        existingTerminalTabId,
        setup,
        issueCommand,
        wrappedSetupCommandStr,
        opts
      )
      return existingTerminalTabId
    }
    if (setup || issueCommand) {
      // Why: runtime-owned worktrees mirror session tabs async, so hold commands for the first mirrored tab instead of dropping them.
      queueHookCommandsForFirstWorktreeTab({
        worktreeId,
        deliver: (state, firstTerminalTabId) =>
          queueSetupAndIssueCommands(
            state,
            worktreeId,
            firstTerminalTabId,
            setup,
            issueCommand,
            wrappedSetupCommandStr,
            opts
          )
      })
    }
    return null
  }

  if (!shouldAutoCreateInitialTerminal(renderableTabCount)) {
    const existingTerminalTabId = store.tabsByWorktree[worktreeId]?.[0]?.id
    if (existingTerminalTabId && (setup || issueCommand)) {
      // Why: main may have adopted the startup tab but failed to spawn setup; renderer must still launch the returned fallback setup.
      queueSetupAndIssueCommands(
        store,
        worktreeId,
        existingTerminalTabId,
        setup,
        issueCommand,
        wrappedSetupCommandStr,
        opts
      )
      return existingTerminalTabId
    }
    return null
  }

  const templatedTabId = applyDefaultTerminalTabs(
    store,
    worktreeId,
    sequencedStartup,
    setup,
    issueCommand,
    defaultTabs,
    wrappedSetupCommandStr,
    opts
  )
  if (templatedTabId) {
    return templatedTabId
  }

  // Why: tag this activation-created tab so its PTY spawn doesn't count as activity and reshuffle the Recent sort.
  // Why: stamp the seeded agent before hooks arrive so native chat and provider chrome can resolve it immediately.
  const launchAgent =
    sequencedStartup?.launchAgent ??
    (sequencedStartup?.telemetry
      ? (agentKindToTuiAgent(sequencedStartup.telemetry.agent_kind) ?? undefined)
      : undefined)
  const terminalTab = store.createTab(worktreeId, undefined, undefined, {
    pendingActivationSpawn: true,
    ...(launchAgent
      ? {
          launchAgent,
          ...initialAgentTabViewModeProps(store.settings ?? null, {
            agent: launchAgent,
            promptDelivery: sequencedStartup?.draftPrompt != null ? 'draft' : undefined,
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              getConnectionId(worktreeId)
            )
          })
        }
      : {}),
    ...(opts?.activateCreatedTabs === false ? { activate: false } : {})
  })
  if (opts?.activateCreatedTabs !== false) {
    store.setActiveTab(terminalTab.id)
  }

  // Why: queue the seeded startup on the initial pane so the terminal begins in the requested agent session instead of an idle shell.
  if (sequencedStartup) {
    if (launchAgent) {
      seedNativeChatAppliedSessionOptions(
        terminalTab.id,
        launchAgent,
        sequencedStartup.sessionOptions
      )
    }
    store.queueTabStartupCommand(terminalTab.id, sequencedStartup)
  }
  queueSetupAndIssueCommands(
    store,
    worktreeId,
    terminalTab.id,
    setup,
    issueCommand,
    wrappedSetupCommandStr,
    opts
  )

  return terminalTab.id
}

function applyDefaultTerminalTabs(
  store: WorktreeActivationStore,
  worktreeId: string,
  startup: WorktreeStartupPayload | undefined,
  setup: WorktreeSetupLaunch | undefined,
  issueCommand: IssueCommandLaunch | undefined,
  defaultTabs: WorktreeDefaultTabsLaunch | undefined,
  wrappedSetupCommandStr: string | undefined,
  opts: { activateCreatedTabs?: boolean } | undefined
): string | null {
  if (!defaultTabs || store.defaultTerminalTabsAppliedByWorktreeId[worktreeId]) {
    return null
  }
  store.markDefaultTerminalTabsApplied(worktreeId)
  if (defaultTabs.tabs.length === 0) {
    return null
  }

  let firstTabId: string | null = null
  for (const [index, template] of defaultTabs.tabs.entries()) {
    const isStartupTab = index === 0 && startup !== undefined
    const launchAgent =
      isStartupTab && startup?.launchAgent
        ? startup.launchAgent
        : isStartupTab && startup?.telemetry
          ? (agentKindToTuiAgent(startup.telemetry.agent_kind) ?? undefined)
          : undefined
    const tab = store.createTab(worktreeId, undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false,
      ...(launchAgent
        ? {
            launchAgent,
            ...initialAgentTabViewModeProps(store.settings ?? null, {
              agent: launchAgent,
              promptDelivery: isStartupTab && startup?.draftPrompt != null ? 'draft' : undefined,
              nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
                getConnectionId(worktreeId)
              )
            })
          }
        : {}),
      ...(opts?.activateCreatedTabs === false ? { activate: false } : {})
    })
    if (index === 0) {
      firstTabId = tab.id
    }
    if (template.title) {
      store.setTabCustomTitle(tab.id, template.title, { recordInteraction: false })
    }
    if (template.color) {
      store.setTabColor(tab.id, template.color)
    }
    const templateCommand = template.command?.trim()
    if (templateCommand && defaultTabs.runCommands && !(index === 0 && startup)) {
      store.queueTabStartupCommand(tab.id, { command: templateCommand })
    }
  }

  if (!firstTabId) {
    return null
  }
  if (opts?.activateCreatedTabs !== false) {
    store.setActiveTab(firstTabId)
  }
  if (startup) {
    const startupAgent =
      startup.launchAgent ??
      (startup.telemetry
        ? (agentKindToTuiAgent(startup.telemetry.agent_kind) ?? undefined)
        : undefined)
    if (startupAgent) {
      seedNativeChatAppliedSessionOptions(firstTabId, startupAgent, startup.sessionOptions)
    }
    store.queueTabStartupCommand(firstTabId, startup)
  }
  queueSetupAndIssueCommands(
    store,
    worktreeId,
    firstTabId,
    setup,
    issueCommand,
    wrappedSetupCommandStr,
    opts
  )
  return firstTabId
}

function queueSetupAndIssueCommands(
  store: WorktreeActivationStore,
  worktreeId: string,
  terminalTabId: string,
  setup: WorktreeSetupLaunch | undefined,
  issueCommand: IssueCommandLaunch | undefined,
  wrappedSetupCommandStr: string | undefined,
  opts: { activateCreatedTabs?: boolean } | undefined
): void {
  // Why: setup launch location is user-configurable — 'new-tab' keeps setup output off the primary pane; splits keep it adjacent.
  if (setup) {
    const mode = useAppStore.getState().settings?.setupScriptLaunchMode ?? 'new-tab'
    const setupCommand = {
      command:
        wrappedSetupCommandStr ?? setup.command ?? buildSetupRunnerCommand(setup.runnerScriptPath),
      env: setup.envVars
    }
    if (mode === 'new-tab') {
      const setupTab = store.createTab(worktreeId, undefined, undefined, {
        recordInteraction: false,
        ...(opts?.activateCreatedTabs === false ? { activate: false } : {})
      })
      // Why: createTab auto-activates the new tab; revert so focus stays on the primary terminal while Setup runs in the background.
      if (opts?.activateCreatedTabs !== false) {
        store.setActiveTab(terminalTabId)
      }
      // Why: customTitle overrides the auto "Terminal N" label everywhere the tab renders, so it's the authoritative label source.
      store.setTabCustomTitle(setupTab.id, 'Setup', { recordInteraction: false })
      store.queueTabStartupCommand(setupTab.id, setupCommand)
    } else {
      store.queueTabSetupSplit(terminalTabId, {
        ...setupCommand,
        direction: mode === 'split-horizontal' ? 'horizontal' : 'vertical'
      })
    }
  }

  // Why: issue automation runs in its own split, queued independently from setup so both can start in parallel (separate concerns).
  if (issueCommand) {
    // Why: WorktreeSetupLaunch carries a runner-script file to shell out to; the TaskPage variant is already an expanded command string.
    const queuedIssueCommand =
      'runnerScriptPath' in issueCommand
        ? {
            command: buildSetupRunnerCommand(issueCommand.runnerScriptPath),
            env: issueCommand.envVars
          }
        : { command: issueCommand.command, env: issueCommand.env }
    store.queueTabIssueCommandSplit(terminalTabId, queuedIssueCommand)
  }
}

// Why: break the import cycle — nav-history slice (under @/store) can't import activation directly, so register the activator here.
setWorktreeNavActivator((workspaceId) => {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    return activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
  }
  return activateAndRevealWorktree(workspaceId)
})

// Why: page entries replay via setActiveView (not open*Page) so back/forward doesn't mutate previousViewBefore* or duplicate history (see navigateToIndex).
setWorktreeNavViewActivator((entry) => {
  if (entry === 'automations') {
    useAppStore.getState().setActiveView(entry)
    return
  }
  if (entry === 'tasks') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'github') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'github',
        preselectedRepoId: entry.workItem.repoId,
        openGitHubWorkItem: entry.workItem,
        openGitHubSourceContext: entry.sourceContext,
        openGitHubInitialTab: entry.initialTab,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'gitlab') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'gitlab',
        preselectedRepoId: entry.workItem.repoId,
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: entry.workItem,
        openGitLabSourceContext: entry.sourceContext,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'jira') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'jira',
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: entry.issue,
        openJiraSourceContext: entry.sourceContext
      }
    }))
    return
  }
  useAppStore.setState((state) => ({
    activeView: 'tasks',
    githubTaskDrawerWorkItem: null,
    taskPageData: {
      ...state.taskPageData,
      taskSource: 'linear',
      openGitHubWorkItem: undefined,
      openGitHubSourceContext: undefined,
      openGitHubInitialTab: undefined,
      openGitLabWorkItem: undefined,
      openGitLabSourceContext: undefined,
      openLinearIssue: entry.issue,
      openLinearSourceContext: entry.sourceContext,
      openJiraIssue: undefined,
      openJiraSourceContext: undefined
    }
  }))
})
