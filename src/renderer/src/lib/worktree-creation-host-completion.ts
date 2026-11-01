import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { showWorktreeCreationReadyToast } from '@/lib/worktree-creation-ready-toast'
import {
  acceptHostCreatedWorktree,
  materializeHostCreatedWorktree
} from '@/lib/worktree-creation-host-result'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { settleHostCreatedLaunchResult } from '@/lib/structured-agent-session-launch-prompt'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/worktree-creation-background-mount'
import {
  notifyWorktreeParentDropped,
  type WorktreeCreateParentPick
} from '@/store/slices/worktrees/create/worktree-create-parent-pick'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { isCreatedWorkspaceInView } from '@/lib/worktree-creation-surface'

export async function completeHostWorktreeCreation(args: {
  creationId: string
  request: WorktreeCreationRequest
  target: RuntimeClientTarget
  executionHostId: ExecutionHostId
  parent: WorktreeCreateParentPick
  launch: AgentLaunchResult
  isCurrent?: () => boolean
  expectedEnvironmentPairingRevision?: number
}): Promise<void> {
  const { creationId, request, target, executionHostId, parent, launch } = args
  const agent = request.hostAgentLaunch?.params.agent ?? request.agent
  if (!agent || args.isCurrent?.() === false) {
    return
  }
  const dismissed = (): boolean => !useAppStore.getState().pendingWorktreeCreations[creationId]
  if (request.hostAgentLaunch) {
    settleHostCreatedLaunchResult(request.hostAgentLaunch.sessionId, executionHostId, launch)
  }
  const created = await acceptHostCreatedWorktree(
    target,
    launch,
    request.repoId,
    executionHostId,
    () => !dismissed(),
    args.isCurrent,
    args.expectedEnvironmentPairingRevision
  )
  if (args.isCurrent?.() === false) {
    return
  }
  if (
    !dismissed() &&
    (parent.staleBeforeCreate || (parent.pickedParentWorktreeId && !created.lineage))
  ) {
    notifyWorktreeParentDropped(useAppStore.getState(), parent)
  }
  try {
    await materializeHostCreatedWorktree(
      target,
      launch.worktreeId,
      args.expectedEnvironmentPairingRevision
    )
  } catch (error) {
    console.warn('worktree create: surface refresh failed', error)
  }
  if (args.isCurrent?.() === false) {
    return
  }
  const terminal =
    launch.outcome.kind === 'terminal' ? parsePaneKey(launch.outcome.paneKey ?? '') : null
  const tabId =
    launch.outcome.kind === 'structured'
      ? structuredAgentSessionTabId(launch.outcome.sessionId)
      : terminal
        ? target.kind === 'environment'
          ? toWebTerminalSurfaceTabId(terminal.tabId)
          : terminal.tabId
        : null
  const actualSurfacePresent = Boolean(
    tabId &&
    useAppStore.getState().unifiedTabsByWorktree[launch.worktreeId]?.some((tab) => tab.id === tabId)
  )
  const focusOnCompletion =
    !dismissed() &&
    actualSurfacePresent &&
    isCreatedWorkspaceInView(useAppStore.getState(), creationId, launch.worktreeId)
  let activation: ActivateAndRevealResult | false = false
  if (focusOnCompletion) {
    try {
      activation = activateAndRevealWorktree(launch.worktreeId, {
        providesInitialSurface: true,
        executionHostId,
        sidebarRevealBehavior: 'auto'
      })
    } catch (error) {
      console.error('worktree create: reveal failed', error)
    }
  }
  if (tabId && actualSurfacePresent) {
    seedNativeChatAppliedSessionOptions(
      tabId,
      agent,
      request.hostAgentLaunch?.params.sessionOptions
    )
  }
  if (created.setup || request.issueCommand) {
    try {
      ensureWorktreeHasInitialTerminal(
        useAppStore.getState(),
        launch.worktreeId,
        undefined,
        created.setup,
        request.issueCommand,
        undefined,
        { callerProvidesSurface: true, activateCreatedTabs: false }
      )
      mountCreatedWorktreeStartupTabsInBackground(launch.worktreeId)
    } catch (error) {
      console.error('worktree create: issue command seeding failed', error)
    }
  }
  if (!dismissed() && !focusOnCompletion) {
    try {
      showWorktreeCreationReadyToast(created.worktree, executionHostId)
    } catch (error) {
      console.warn('worktree create: ready toast failed', error)
    }
  }
  try {
    await completeWorktreeCreation({
      creationId,
      request,
      worktreeId: launch.worktreeId,
      structuredLaunchAccepted: true,
      activation,
      primaryTabId: tabId,
      backendSpawned: true,
      hostPlannedStartup: false,
      focusOnCompletion
    })
  } catch (error) {
    console.warn('worktree create: completion cleanup failed', error)
  }
}
