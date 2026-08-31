import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { createSequencedSetupAgentCommands } from '../../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../../shared/setup-runner-command'
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import { useAppStore } from '@/store'
import { queueHookCommandsForFirstWorktreeTab } from '@/lib/hook-command-delayed-delivery'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'
import { initialAgentTabViewModeProps } from './native-chat-initial-view-mode'
import { getConnectionId } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'
import {
  draftViewModeProps,
  resolveStartupLaunchDraftText,
  type WorktreeStartupPayload
} from '@/lib/worktree-startup-payload'
import {
  queueSetupAndIssueCommands,
  type IssueCommandLaunch
} from '@/lib/worktree-setup-issue-command-queue'
import { applyDefaultTerminalTabs } from '@/lib/worktree-default-terminal-tabs'

function getSetupRunnerCommandPlatformForLaunch(setup: WorktreeSetupLaunch): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(
    setup.runnerScriptPath,
    navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
  )
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
  // Why: creating a terminal just because the legacy terminal slice is empty gives editor/browser-only worktrees an unexpected extra tab.
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
  }

  const backendStartupTerminalSpawned = opts?.backendStartupTerminalSpawned === true
  const hostAuthority = resolveWorkspaceTerminalHostAuthority(ownerState, worktreeId)
  // Why: explicit spawn evidence survives the new-worktree ownership race; a host that owns terminal creation provides the same authority for later activations.
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

  const hasExplicitLaunchWork = Boolean(sequencedStartup || setup || issueCommand)
  // Why: only startup hydration honours the closed-last-tab tombstone. Every explicit
  // activation (sidebar, palette, automation resume, wake) re-seeds a surface instead,
  // because closing the last terminal normally deactivates the workspace too
  // (terminal-tab-actions.ts closeTerminalTab, plus leaveWorktreeIfEmpty for split-group
  // closes) — so reaching here through an activation means the user asked for it back.
  // The paths that do leave it active stay safe: a runtime-owned close returns before that
  // deactivation, but while that session is live the host owns terminal creation and this
  // bails out above; an editor/browser survivor keeps renderableTabCount non-zero, so no
  // terminal is added; and closeTabPreservingPty (use-terminal-pane-lifecycle.ts) skips both
  // deactivation hooks for pane moves and retirement, where re-seeding is the wanted outcome.
  const shouldHonourClosedTerminalTombstone =
    Object.hasOwn(store.tabsByWorktree, worktreeId) && opts?.reseedEmptiedWorkspace !== true
  // Why: an execution host that has not answered is not a host with no terminals; seeding into that
  // gap is what adds a tab per launch (STA-4658). Explicit launch work below is a request to create
  // a terminal now, so it stays ungated.
  const shouldAutoCreate =
    hostAuthority === 'none' &&
    shouldAutoCreateInitialTerminal(renderableTabCount, shouldHonourClosedTerminalTombstone)
  const shouldCreateForExplicitWork = renderableTabCount === 0 && hasExplicitLaunchWork
  if (!shouldAutoCreate && !shouldCreateForExplicitWork) {
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
            // Why: argv-prefill launches carry the draft in `command` and set no
            // draftPrompt, so gating on draftPrompt alone misses them entirely.
            ...draftViewModeProps(resolveStartupLaunchDraftText(sequencedStartup)),
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
