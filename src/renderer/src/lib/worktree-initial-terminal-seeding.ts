import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { isTerminalWorkspaceEmptiedOnPurpose } from '../../../shared/closed-terminal-tab-tombstones'
import { shouldSeedWorktreePrimaryTerminal } from '../../../shared/worktree-first-surface'
import { createSequencedSetupAgentCommands } from '../../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../../shared/setup-runner-command'
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import { useAppStore } from '@/store'
import { queueHookCommandsForFirstWorktreeTab } from '@/lib/hook-command-delayed-delivery'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import {
  queueSetupAndIssueCommands,
  type IssueCommandLaunch
} from '@/lib/worktree-setup-issue-command-queue'
import { applyDefaultTerminalTabs } from '@/lib/worktree-default-terminal-tabs'
import { openDefaultAgentChatInEmptyWorkspace } from '@/lib/empty-workspace-default-agent-chat'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import { findPendingWorktreeCreationId } from './pending-worktree-creation'

function getSetupRunnerCommandPlatformForLaunch(setup: WorktreeSetupLaunch): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(
    setup.runnerScriptPath,
    navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
  )
}

export type GatedEmptyWorkspaceReseedIntent = {
  callerProvidesSurface: boolean
  seedUserDefaultSurface: boolean
  executionHostId?: ExecutionHostId
}

/** Re-seed after an empty gate unless its activation owns the surface or no longer owns the host. */
export function reseedGatedEmptyWorkspace(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent
): void {
  const { callerProvidesSurface, seedUserDefaultSurface, executionHostId } = intent
  const state = useAppStore.getState()
  if (
    callerProvidesSurface === true ||
    isEmptyWorkspaceDefaultSurfacePending(workspaceKey) ||
    state.activeWorktreeId !== workspaceKey ||
    (executionHostId !== undefined && state.activeWorkspaceExecutionHostId !== executionHostId)
  ) {
    return
  }
  ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      reseedEmptiedWorkspace: true,
      ...(seedUserDefaultSurface ? { seedUserDefaultSurface: true } : {})
    }
  )
}

export function ensureFolderWorkspaceInitialTerminal(
  folderWorkspace: FolderWorkspace,
  startup?: WorktreeStartupPayload,
  providesInitialSurface?: boolean,
  seedUserDefaultSurface?: boolean
): string | null {
  if (providesInitialSurface === true && startup === undefined) {
    return null
  }
  const state = useAppStore.getState()
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    startup,
    undefined,
    undefined,
    undefined,
    {
      reseedEmptiedWorkspace: providesInitialSurface !== true,
      ...(seedUserDefaultSurface ? { seedUserDefaultSurface: true } : {})
    }
  )
  return primaryTabId
}

export function ensureWorktreeHasInitialTerminal(
  store: WorktreeActivationStore,
  worktreeId: string,
  startup?: WorktreeStartupPayload,
  setup?: WorktreeSetupLaunch,
  issueCommand?: IssueCommandLaunch,
  defaultTabs?: WorktreeDefaultTabsLaunch,
  opts?: InitialTerminalOptions
): string | null {
  const { renderableTabCount } = store.reconcileWorktreeTabModel(worktreeId)
  // Editor/browser-only workspaces need no extra terminal merely because the legacy terminal slice is empty.
  const ownerState =
    store.settings !== undefined || store.repos !== undefined || store.worktreesByRepo !== undefined
      ? store
      : useAppStore.getState()
  let sequencedStartup = startup
  let wrappedSetupCommandStr: string | undefined

  if (startup && setup?.waitForAgentStartup === true) {
    const platform = getSetupRunnerCommandPlatformForLaunch(setup)
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform,
      shell: setup.shell
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
    setup = { ...setup, envVars: { ...setup.envVars, ...sequenced.setupEnv } }
  }

  const backendStartupTerminalSpawned = opts?.backendStartupTerminalSpawned === true
  const hostAuthority = resolveWorkspaceTerminalHostAuthority(
    ownerState,
    worktreeId,
    opts?.executionHostId
  )
  // Explicit spawn evidence survives new-worktree ownership races; later activations also defer to host-owned terminal creation.
  if (backendStartupTerminalSpawned || hostAuthority === 'live') {
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
    if (existingTerminalTabId && backendStartupTerminalSpawned) {
      return existingTerminalTabId
    }
    if (setup || issueCommand) {
      // Runtime tabs mirror asynchronously; retain commands until the first tab arrives.
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

  const hasExplicitLaunchWork = Boolean(sequencedStartup || setup || issueCommand)
  const pendingCreationId = findPendingWorktreeCreationId(
    ownerState.pendingWorktreeCreations,
    worktreeId
  )
  // Why: a checkout can become selectable before creation has handed off its chosen surface.
  if (
    pendingCreationId &&
    opts?.worktreeCreationId !== pendingCreationId &&
    !hasExplicitLaunchWork
  ) {
    return null
  }
  if (
    renderableTabCount === 0 &&
    !shouldSeedWorktreePrimaryTerminal({
      hasPrimarySurface: false,
      callerProvidesSurface: opts?.callerProvidesSurface === true,
      startupNeedsTerminal: sequencedStartup !== undefined,
      issueCommandNeedsTerminal: issueCommand !== undefined
    }) &&
    !defaultTabs?.tabs.length &&
    opts?.createNewTerminalForStartup !== true
  ) {
    queueSetupAndIssueCommands(
      store,
      worktreeId,
      null,
      setup,
      undefined,
      wrappedSetupCommandStr,
      opts
    )
    return null
  }
  // Only passive startup honors last-close tombstones; explicit activation requests a surface because closing the last terminal normally deactivates. Runtime-owned live sessions bail above, editor/browser survivors remain renderable, and pane moves/retirement intentionally allow reseeding.
  const shouldHonourClosedTerminalTombstone =
    isTerminalWorkspaceEmptiedOnPurpose(store, worktreeId) && opts?.reseedEmptiedWorkspace !== true
  // An unanswered host is not empty; seeding there adds a tab per launch (STA-4658). Explicit launch requests below remain ungated.
  const shouldAutoCreate =
    hostAuthority === 'none' &&
    shouldAutoCreateInitialTerminal(renderableTabCount, shouldHonourClosedTerminalTombstone)
  const shouldCreateForExplicitWork = renderableTabCount === 0 && hasExplicitLaunchWork
  const shouldCreateNewStartupTerminal =
    opts?.createNewTerminalForStartup === true && sequencedStartup !== undefined
  if (!shouldAutoCreate && !shouldCreateForExplicitWork && !shouldCreateNewStartupTerminal) {
    const existingTerminalTabId = store.tabsByWorktree[worktreeId]?.[0]?.id
    if (existingTerminalTabId && (setup || issueCommand)) {
      // Main can adopt the startup tab yet fail setup spawn; renderer still runs returned fallback setup.
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
  if (
    opts?.seedUserDefaultSurface === true &&
    !hasExplicitLaunchWork &&
    opts.activateCreatedTabs !== false
  ) {
    const defaultChat = openDefaultAgentChatInEmptyWorkspace(
      worktreeId,
      () =>
        ensureWorktreeHasInitialTerminal(
          store,
          worktreeId,
          startup,
          setup,
          issueCommand,
          defaultTabs,
          { ...opts, seedUserDefaultSurface: false }
        ) !== null
    )
    if (defaultChat) {
      return defaultChat.primaryTabId
    }
  }

  // Activation-created PTY spawns must not count as activity and reshuffle Recent.
  // Stamp before hooks so chat/provider chrome can resolve agent identity immediately.
  const launchAgent =
    sequencedStartup?.launchAgent ??
    (sequencedStartup?.telemetry
      ? (agentKindToTuiAgent(sequencedStartup.telemetry.agent_kind) ?? undefined)
      : undefined)
  const terminalTab = store.createTab(worktreeId, undefined, undefined, {
    pendingActivationSpawn: true,
    ...(launchAgent ? { launchAgent } : {}),
    ...(opts?.activateCreatedTabs === false ? { activate: false } : {}),
    ...(sequencedStartup ? { pendingStartup: sequencedStartup } : {})
  })
  if (opts?.activateCreatedTabs !== false) {
    store.setActiveTab(terminalTab.id)
  }
  if (sequencedStartup && launchAgent) {
    seedNativeChatAppliedSessionOptions(
      terminalTab.id,
      launchAgent,
      sequencedStartup.sessionOptions
    )
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
