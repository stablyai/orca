import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from '../pty-transport-types'
import type { RuntimeCreateAgentSessionResult } from '../../../../../../shared/agent-session/agent-session-host-authority'
import {
  createAgentSessionCreateOperation,
  type AgentSessionCreateOperation
} from '../../../../runtime/hosted-terminals/creation/agent-launch/agent-session-create-operation'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeTerminalWorktreeSelector } from '../../../../runtime/rpc/targets/runtime-worktree-selector'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]
const modelLaunchOperations = new WeakMap<IpcPtyTransportOptions, AgentSessionCreateOperation>()

/** Fence buffered state by PTY lifetime during connect; older hosts omit incarnationId, and later PtyConnectResult consumers do not need it. */
export type IpcPtySpawnResponse = PtyConnectResult & {
  isReattach?: boolean
  incarnationId?: string
}

export async function spawnIpcPty(
  transportOptions: IpcPtyTransportOptions,
  connectOptions: PtyConnectOptions,
  admittedSessionId?: string,
  /** The user's "let agents ask" answer for this launch. */
  skipAgentWorkspaceTrust = false
): Promise<IpcPtySpawnResponse> {
  if (
    !admittedSessionId &&
    transportOptions.launchAgent === 'opencode' &&
    Object.values(transportOptions.agentLaunchPreferences ?? {}).some(
      (value) => value !== undefined
    )
  ) {
    const { worktreeId, tabId, leafId, connectionId, resumeProviderSession } = transportOptions
    if (!worktreeId || !tabId || !leafId || connectionId || resumeProviderSession) {
      throw new Error('capability_unsupported')
    }
    let operation = modelLaunchOperations.get(transportOptions)
    if (!operation) {
      operation = createAgentSessionCreateOperation()
      modelLaunchOperations.set(transportOptions, operation)
    }
    const created = await operation.run((clientOperationId) =>
      callRuntimeRpc<RuntimeCreateAgentSessionResult>(
        { kind: 'local' },
        'terminal.createAgentSession',
        {
          clientOperationId,
          worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
          agent: 'opencode',
          prompt: transportOptions.agentPrompt,
          promptDelivery: transportOptions.agentPromptDelivery,
          agentArgs: transportOptions.agentArgsOverride,
          launchPreferences: transportOptions.agentLaunchPreferences,
          startupCwd: transportOptions.cwd,
          ...(transportOptions.trustWorktreeId
            ? { trustWorktreeId: transportOptions.trustWorktreeId }
            : {}),
          placement: { tabId, leafId },
          presentation: 'background',
          ...(transportOptions.terminalKittyKeyboardProtocol === true
            ? { terminalKittyKeyboardProtocol: true }
            : {})
        }
      )
    )
    if (!created.terminal.ptyId) {
      throw new Error('agent_session_operation_unknown')
    }
    return spawnIpcPty(
      { ...transportOptions, command: undefined, launchConfig: undefined },
      { ...connectOptions, command: undefined, launchConfig: undefined },
      created.terminal.ptyId
    )
  }
  const {
    cwd,
    env,
    envToDelete,
    command,
    commandDelivery,
    launchConfig,
    resumeProviderSession,
    resumeOrigin,
    launchToken,
    launchAgent,
    startupCommandDelivery,
    connectionId,
    worktreeId,
    tabId,
    leafId,
    placement,
    shellOverride,
    projectRuntime,
    terminalColorQueryReplies,
    terminalKittyKeyboardProtocol,
    telemetry,
    agentLaunch
  } = transportOptions
  const resumesAgent = Boolean(connectOptions.resumeProviderSession ?? resumeProviderSession)
  const spawnIntent =
    resumesAgent && !admittedSessionId ? connectOptions.resumeSpawnIntent : undefined
  // Why: a reattach under an admitted session id must never stop the PTY it is reattaching.
  const replacesPtyId = admittedSessionId ? null : (connectOptions.claimReplacedPtyId?.() ?? null)
  return window.api.pty.spawn({
    cols: connectOptions.cols ?? 80,
    rows: connectOptions.rows ?? 24,
    cwd,
    env: connectOptions.env ?? env,
    ...((connectOptions.envToDelete ?? envToDelete)
      ? { envToDelete: connectOptions.envToDelete ?? envToDelete }
      : {}),
    command: connectOptions.command ?? command,
    ...((connectOptions.commandDelivery ?? commandDelivery)
      ? { commandDelivery: connectOptions.commandDelivery ?? commandDelivery }
      : {}),
    ...((connectOptions.launchConfig ?? launchConfig)
      ? { launchConfig: connectOptions.launchConfig ?? launchConfig }
      : {}),
    ...((connectOptions.resumeProviderSession ?? resumeProviderSession)
      ? { resumeProviderSession: connectOptions.resumeProviderSession ?? resumeProviderSession }
      : {}),
    ...(resumesAgent && (connectOptions.resumeOrigin ?? resumeOrigin)
      ? { resumeOrigin: connectOptions.resumeOrigin ?? resumeOrigin }
      : {}),
    ...((connectOptions.launchToken ?? launchToken)
      ? { launchToken: connectOptions.launchToken ?? launchToken }
      : {}),
    ...((connectOptions.launchAgent ?? launchAgent)
      ? { launchAgent: connectOptions.launchAgent ?? launchAgent }
      : {}),
    ...((connectOptions.startupCommandDelivery ?? startupCommandDelivery)
      ? {
          startupCommandDelivery: connectOptions.startupCommandDelivery ?? startupCommandDelivery
        }
      : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(admittedSessionId ? { sessionId: admittedSessionId } : {}),
    ...(connectOptions.initiallyHidden ? { initiallyHidden: true } : {}),
    ...(connectOptions.attachOnlyView ? { attachOnlyView: true } : {}),
    worktreeId,
    ...(transportOptions.trustWorktreeId
      ? { trustWorktreeId: transportOptions.trustWorktreeId }
      : {}),
    ...(tabId ? { tabId } : {}),
    ...(leafId ? { leafId } : {}),
    ...(placement && !admittedSessionId ? { placement } : {}),
    ...(spawnIntent ? { spawnIntent } : {}),
    ...(connectOptions.wslPassiveRestore ? { wslPassiveRestore: true as const } : {}),
    ...(skipAgentWorkspaceTrust ? { skipAgentWorkspaceTrust: true as const } : {}),
    ...(replacesPtyId ? { replacesPtyId } : {}),
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(terminalKittyKeyboardProtocol === true ? { terminalKittyKeyboardProtocol: true } : {}),
    ...(telemetry ? { telemetry } : {}),
    ...(agentLaunch && !admittedSessionId ? { agentLaunch } : {})
  })
}
