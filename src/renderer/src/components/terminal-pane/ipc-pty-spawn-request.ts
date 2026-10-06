import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import type { RuntimeCreateAgentSessionResult } from '../../../../shared/agent-session-host-authority'
import {
  createAgentSessionCreateOperation,
  type AgentSessionCreateOperation
} from '../../runtime/agent-session-create-operation'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { toRuntimeTerminalWorktreeSelector } from '../../runtime/runtime-worktree-selector'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]
const modelLaunchOperations = new WeakMap<IpcPtyTransportOptions, AgentSessionCreateOperation>()

/** `incarnationId` names which lifetime of the returned id this spawn owns; absent when the
 *  execution host predates the field. It is deliberately NOT on `PtyConnectResult` — only the
 *  connect handshake needs it, to fence buffered state left by an earlier owner of the same id. */
export type IpcPtySpawnResponse = PtyConnectResult & {
  isReattach?: boolean
  incarnationId?: string
}

export async function spawnIpcPty(
  transportOptions: IpcPtyTransportOptions,
  connectOptions: PtyConnectOptions,
  admittedSessionId?: string
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
    cwdFallback,
    env,
    envToDelete,
    command,
    commandDelivery,
    agentProfileId,
    launchConfig,
    resumeProviderSession,
    launchToken,
    launchAgent,
    startupCommandDelivery,
    connectionId,
    worktreeId,
    tabId,
    leafId,
    shellOverride,
    projectRuntime,
    terminalColorQueryReplies,
    terminalKittyKeyboardProtocol,
    telemetry
  } = transportOptions
  const shouldSendLocalCwdFallback =
    cwdFallback === 'worktree' && !connectionId && !admittedSessionId
  // Why: a reattach under an admitted session id must never stop the PTY it is reattaching.
  const replacesPtyId = admittedSessionId ? null : (connectOptions.claimReplacedPtyId?.() ?? null)
  return window.api.pty.spawn({
    cols: connectOptions.cols ?? 80,
    rows: connectOptions.rows ?? 24,
    cwd,
    ...(shouldSendLocalCwdFallback ? { cwdFallback } : {}),
    env: connectOptions.env ?? env,
    ...((connectOptions.envToDelete ?? envToDelete)
      ? { envToDelete: connectOptions.envToDelete ?? envToDelete }
      : {}),
    command: connectOptions.command ?? command,
    ...((connectOptions.commandDelivery ?? commandDelivery)
      ? { commandDelivery: connectOptions.commandDelivery ?? commandDelivery }
      : {}),
    ...((connectOptions.agentProfileId ?? agentProfileId) !== undefined
      ? { agentProfileId: connectOptions.agentProfileId ?? agentProfileId }
      : {}),
    ...((connectOptions.launchConfig ?? launchConfig)
      ? { launchConfig: connectOptions.launchConfig ?? launchConfig }
      : {}),
    ...((connectOptions.resumeProviderSession ?? resumeProviderSession)
      ? { resumeProviderSession: connectOptions.resumeProviderSession ?? resumeProviderSession }
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
    worktreeId,
    ...(tabId ? { tabId } : {}),
    ...(leafId ? { leafId } : {}),
    ...(replacesPtyId ? { replacesPtyId } : {}),
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(terminalKittyKeyboardProtocol === true ? { terminalKittyKeyboardProtocol: true } : {}),
    ...(telemetry ? { telemetry } : {})
  })
}
