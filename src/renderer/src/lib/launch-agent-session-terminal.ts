import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from './agent-launch-prompt-delivery'
import { createPasteReadinessTimeoutNotice } from './launch-agent-paste-timeout-notice'
import {
  prepareAgentInNewTabLaunch,
  type PreparedAgentInNewTabLaunch
} from './launch-agent-new-tab-preparation'
import type { AgentSessionLaunchRequest, TerminalLaunchResult } from './launch-agent-session'
import { preflightAgentTrust } from './agent-trust-preflight'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { spawnWebRuntimeAgentSurface } from './web-runtime-worktree-terminal-after-wake'
import { activateAndRevealWorkspace } from './worktree-activation'
import { tuiAgentToAgentKind } from './telemetry'
import { seedCommandCodeSubmittedPromptStatus } from './command-code-prompt-status-seed'
import type { WorktreeStartupPayload } from './worktree-startup-payload'
import { useAppStore } from '@/store'

function terminalStartup(
  request: AgentSessionLaunchRequest,
  prepared: PreparedAgentInNewTabLaunch
): WorktreeStartupPayload {
  const { startupPlan } = prepared
  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
    launchAgent: request.agent,
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(request.promptDelivery === 'draft' && prepared.trimmedPrompt
      ? { launchDraftText: prepared.trimmedPrompt }
      : {}),
    ...(request.agent === 'command-code' && prepared.hasPrompt
      ? { initialAgentStatus: { agent: request.agent, prompt: prepared.trimmedPrompt } }
      : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(request.agent),
      launch_source: request.launchSource,
      request_kind: 'new'
    }
  }
}

async function applyPendingRename(request: AgentSessionLaunchRequest): Promise<void> {
  if (!request.pendingFirstAgentMessageRename) {
    return
  }
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(request.workspaceId)
  if (scope?.type === 'folder') {
    await state
      .updateFolderWorkspace(scope.folderWorkspaceId, { pendingFirstAgentMessageRename: true })
      .catch(() => undefined)
    return
  }
  await state
    .updateWorktreeMeta(request.workspaceId, { pendingFirstAgentMessageRename: true })
    .catch(() => undefined)
}

async function markLaunchTrusted(request: AgentSessionLaunchRequest): Promise<void> {
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(request.workspaceId)
  if (scope?.type === 'folder') {
    const workspace = state.folderWorkspaces.find(
      (candidate) => candidate.id === scope.folderWorkspaceId
    )
    await preflightAgentTrust({
      agent: request.agent,
      workspacePath: workspace?.folderPath,
      connectionId: getConnectionIdFromState(state, request.workspaceId)
    })
    return
  }
  const worktree = state.allWorktrees?.().find((candidate) => candidate.id === request.workspaceId)
  const connectionId = getConnectionIdFromState(state, request.workspaceId)
  await preflightAgentTrust({ agent: request.agent, workspacePath: worktree?.path, connectionId })
}

function deliverTerminalPrompt(
  request: AgentSessionLaunchRequest,
  prepared: PreparedAgentInNewTabLaunch,
  tabId: string | null
): Promise<{ delivered: boolean; failureNotified: boolean }> | undefined {
  if (!tabId) {
    return undefined
  }
  if (prepared.pasteDraftAfterLaunch === null) {
    if (request.promptDelivery === 'draft' && prepared.trimmedPrompt) {
      seedNativeChatLaunchDraftForAgentTab({
        tabId,
        agent: request.agent,
        text: prepared.trimmedPrompt
      })
    }
    if (prepared.hasPrompt) {
      request.onPromptDelivered?.()
      if (request.promptDelivery !== 'draft') {
        return Promise.resolve({ delivered: true, failureNotified: false })
      }
    }
    return undefined
  }
  const timeoutNotice = createPasteReadinessTimeoutNotice({
    worktreeId: request.workspaceId,
    tabId,
    agent: request.agent,
    submitted: prepared.submitPastedPrompt
  })
  const delivery = deliverLaunchPromptToAgentTab({
    tabId,
    content: prepared.pasteDraftAfterLaunch,
    agent: request.agent,
    submit: prepared.submitPastedPrompt,
    forcePaste: request.promptDelivery === 'submit-after-ready',
    onTimeout: timeoutNotice.onTimeout
  }).then((delivered) => {
    if (delivered) {
      if (request.agent === 'command-code' && prepared.submitPastedPrompt) {
        seedCommandCodeSubmittedPromptStatus(request.workspaceId, tabId, prepared.trimmedPrompt)
      }
      request.onPromptDelivered?.()
    }
    return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
  })
  void delivery.catch((error) => console.error('Prompt delivery failed after launch', error))
  return delivery
}

export async function launchTerminalSession(
  request: AgentSessionLaunchRequest
): Promise<TerminalLaunchResult> {
  if (request.signal?.aborted) {
    return { tabId: null }
  }
  await applyPendingRename(request)
  if (request.signal?.aborted) {
    return { tabId: null }
  }
  await markLaunchTrusted(request)
  if (request.signal?.aborted) {
    return { tabId: null }
  }
  const prepared = request.terminalStartup
    ? null
    : prepareAgentInNewTabLaunch({
        agent: request.agent,
        worktreeId: request.workspaceId,
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {}),
        ...(request.tuiCustomization?.agentArgs !== undefined
          ? { agentArgs: request.tuiCustomization.agentArgs }
          : {}),
        ...(request.tuiCustomization?.cwd !== undefined
          ? { initialCwd: request.tuiCustomization.cwd }
          : {}),
        ...(request.launchPlatform ? { launchPlatform: request.launchPlatform } : {}),
        ...(request.initialSessionOptions
          ? { initialSessionOptions: request.initialSessionOptions }
          : {}),
        launchSource: request.launchSource,
        ...(request.onPromptDelivered ? { onPromptDelivered: request.onPromptDelivered } : {})
      })
  if (!prepared && !request.terminalStartup) {
    return { tabId: null, error: new Error('Could not build the agent startup command.') }
  }
  const startup = request.terminalStartup ?? terminalStartup(request, prepared!)
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, request.workspaceId)
  let tabId: string | null = null
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const created = await spawnWebRuntimeAgentSurface(request.workspaceId, {
      runtimeEnvironmentId,
      startup,
      agent: request.agent,
      cwd: request.tuiCustomization?.cwd,
      targetGroupId: request.groupId,
      activate: request.visibility === 'reveal'
    })
    tabId = created?.hostTabId ?? null
    if (request.visibility === 'reveal') {
      activateAndRevealWorkspace(request.workspaceId, {
        revealInSidebar: true,
        sidebarRevealBehavior: 'auto',
        ...(request.groupId ? { targetGroupId: request.groupId } : {}),
        providesInitialSurface: true
      })
    }
    if (created?.outcome.status === 'failed') {
      return { tabId, error: new Error(created.outcome.message) }
    }
  } else if (request.visibility === 'reveal') {
    const activation = activateAndRevealWorkspace(request.workspaceId, {
      revealInSidebar: true,
      sidebarRevealBehavior: 'auto',
      createNewTerminalForStartup: true,
      ...(request.groupId ? { targetGroupId: request.groupId } : {}),
      startup,
      providesInitialSurface: true,
      ...(request.tuiCustomization?.cwd ? { initialCwd: request.tuiCustomization.cwd } : {})
    })
    tabId = activation === false ? null : activation.primaryTabId
  } else {
    tabId = ensureWorktreeHasInitialTerminal(
      state,
      request.workspaceId,
      startup,
      undefined,
      undefined,
      undefined,
      {
        activateCreatedTabs: false,
        createNewTerminalForStartup: true,
        ...(request.groupId ? { targetGroupId: request.groupId } : {})
      }
    )
  }
  const promptDeliveryResult = prepared
    ? deliverTerminalPrompt(request, prepared, tabId)
    : undefined
  return { tabId, ...(promptDeliveryResult ? { promptDeliveryResult } : {}) }
}
