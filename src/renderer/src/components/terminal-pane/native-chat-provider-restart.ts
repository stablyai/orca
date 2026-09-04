import { useAppStore } from '@/store'
import { createTerminalShutdownGuardController } from '@/store/terminals/terminal-shutdown-guards'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { detectAgentSessionContinuationAgents } from '@/lib/launch-agent-session-continuation'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from '../native-chat/native-chat-send-eligibility'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { seedNativeChatAppliedSessionOptions } from '../native-chat/native-chat-session-option-cache'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { StructuredSwitchableAgent } from '../../../../shared/structured-agent-session-switchable-models'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'

export async function restartNativeChatProvider(
  controller: TerminalPaneController,
  agent: StructuredSwitchableAgent,
  model: string
): Promise<string> {
  const pane = controller.chatPane
  const expectedPtyId = controller.chatPanePtyId
  if (!pane || !expectedPtyId) {
    throw new Error('The chat has no connected terminal.')
  }
  const transport = controller.paneTransportsRef.current.get(pane.id)
  const isCurrent = () =>
    transport?.isConnected() &&
    transport.getPtyId() === expectedPtyId &&
    controller.paneTransportsRef.current.get(pane.id) === transport
  const paneKey = makePaneKey(controller.tabId, pane.leafId)
  const agents = await detectAgentSessionContinuationAgents(controller.worktreeId)
  const state = useAppStore.getState()
  if (!agents.includes(agent) || !isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    throw new Error('This provider is not available on this workspace host.')
  }
  if (!isCurrent() || !deriveNativeChatCanSend(getDriverForPty(expectedPtyId))) {
    throw new Error('The chat connection changed. Try again once it reconnects.')
  }
  if (state.agentStatusByPaneKey[paneKey]?.state === 'working') {
    throw new Error('Wait for the current response before switching providers.')
  }
  const connectionId = transport?.getConnectionId?.()
  const isRemote = Boolean(connectionId)
  const platform = resolveTerminalInputHostPlatform({
    clientPlatform: CLIENT_PLATFORM,
    state,
    worktreeId: controller.worktreeId,
    transport: transport ?? null
  })
  const startup = buildAgentStartupPlan({
    agent,
    prompt: '',
    allowEmptyPromptLaunch: true,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv),
    platform,
    isRemote,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: state.settings?.terminalWindowsShell
    }),
    sessionOptions: { model },
    sessionOptionsOverrideAgentArgs: true
  })
  if (!startup) {
    throw new Error('Could not prepare this provider for launch.')
  }
  if (!isCurrent()) {
    throw new Error('The chat connection changed before switching.')
  }
  const runtimeId = transport?.getRuntimeEnvironmentId?.()
  const terminal = getRemoteRuntimeTerminalHandle(expectedPtyId)
  const target = runtimeId
    ? { kind: 'environment' as const, environmentId: runtimeId }
    : getActiveRuntimeTarget(getSettingsForAgentTabRuntimeOwner(controller.tabId))
  const hostPtyId = terminal
    ? (await callRuntimeRpc<RuntimeTerminalShow>(target, 'terminal.show', { terminal })).ptyId
    : expectedPtyId
  if (!hostPtyId || !isCurrent()) {
    throw new Error('The chat connection changed before switching.')
  }
  if (
    useAppStore.getState().agentStatusByPaneKey[paneKey]?.state === 'working' ||
    !deriveNativeChatCanSend(getDriverForPty(expectedPtyId))
  ) {
    throw new Error('Wait for the current response before switching providers.')
  }
  const shutdown = createTerminalShutdownGuardController({
    exitGuardPtyIds: [expectedPtyId],
    rendererShutdownPtyIds: [expectedPtyId],
    get: useAppStore.getState,
    set: useAppStore.setState,
    keepIdentifiers: true,
    runtimeEnvironmentId: runtimeId ?? null,
    tabs: []
  })
  shutdown.markShutdownPending()
  shutdown.unregisterHandlers()
  try {
    const result = await callRuntimeRpc<{ stoppedPtyIds: string[]; postStopVerified: boolean }>(
      target,
      'terminal.stopExact',
      {
        worktree: toRuntimeWorktreeSelector(controller.worktreeId),
        expectedPtyIds: [hostPtyId],
        keepHistory: true,
        targetOnly: true
      }
    )
    if (
      result.postStopVerified !== true ||
      result.stoppedPtyIds.length !== 1 ||
      result.stoppedPtyIds[0] !== hostPtyId
    ) {
      throw new Error('The workspace host could not confirm that the previous provider stopped.')
    }
  } catch (error) {
    shutdown.rollbackShutdown()
    throw error
  }
  // Only the owning host's acknowledged close permits a replacement process.
  if (controller.paneTransportsRef.current.get(pane.id) !== transport) {
    shutdown.settlePartialRendererStop([expectedPtyId])
    throw new Error('The pane changed while its provider was stopping.')
  }
  transport?.detach?.({ preserveExitObserver: false })
  controller.panePtyBindingsRef.current.get(pane.id)?.dispose()
  controller.panePtyBindingsRef.current.delete(pane.id)
  state.consumeSuppressedPtyExit(expectedPtyId)
  state.clearNativeChatLaunchDraft(controller.tabId)
  state.clearNativeChatLaunchPrompt(controller.tabId)
  state.dropAgentStatus(paneKey)
  state.clearSleepingAgentSession(paneKey)
  shutdown.settlePartialRendererStop([expectedPtyId])
  state.clearTabPtyId(controller.tabId, expectedPtyId)
  seedNativeChatAppliedSessionOptions(controller.tabId, agent, startup.sessionOptions)
  const initialCwd = controller.paneCwdRef.current.get(pane.id)?.cwd ?? controller.cwd
  await controller.handleRestartChatPane(
    pane.id,
    {
      command: startup.launchCommand,
      env: startup.env,
      launchAgent: agent,
      launchConfig: startup.launchConfig,
      sessionOptions: startup.sessionOptions,
      startupCommandDelivery: startup.startupCommandDelivery
    },
    initialCwd
  )
  const replacementPtyId = controller.paneTransportsRef.current.get(pane.id)?.getPtyId()
  if (!replacementPtyId) {
    throw new Error('The replacement provider did not connect to the chat.')
  }
  seedNativeChatAppliedSessionOptions(replacementPtyId, agent, startup.sessionOptions)
  return replacementPtyId
}
