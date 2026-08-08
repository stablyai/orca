import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import { isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import type { RuntimeEnsureAgentSessionResult } from '../../../../shared/agent-session-host-authority'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeTerminalWorktreeSelector } from '@/runtime/runtime-worktree-selector'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

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
  const {
    cwd,
    cwdFallback,
    env,
    envToDelete,
    command,
    commandDelivery,
    launchConfig,
    resumeProviderSession,
    agentArgsOverride,
    agentLaunchPreferences,
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
    telemetry
  } = transportOptions
  const shouldSendLocalCwdFallback =
    cwdFallback === 'worktree' && !connectionId && !admittedSessionId
  const providerSessionToResume = connectOptions.resumeProviderSession ?? resumeProviderSession
  const launchAgentToSend = connectOptions.launchAgent ?? launchAgent
  const launchConfigToSend = connectOptions.launchConfig ?? launchConfig
  if (
    !connectionId &&
    !admittedSessionId &&
    worktreeId &&
    providerSessionToResume &&
    isResumableTuiAgent(launchAgentToSend)
  ) {
    try {
      const ensured = await callRuntimeRpc<RuntimeEnsureAgentSessionResult>(
        { kind: 'local' },
        'terminal.ensureAgentSession',
        {
          kind: 'explicit',
          worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
          agent: launchAgentToSend,
          providerSession: providerSessionToResume,
          ...(launchConfigToSend?.ompResumeFilePath
            ? { ompResumeFilePath: launchConfigToSend.ompResumeFilePath }
            : {}),
          ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
          ...(agentLaunchPreferences ? { launchPreferences: agentLaunchPreferences } : {}),
          placement: { tabId, leafId },
          presentation: 'background'
        }
      )
      if (!ensured.terminal.ptyId) {
        throw new Error('Agent session did not provide a PTY')
      }
      return {
        id: ensured.terminal.ptyId,
        isReattach: ensured.disposition === 'adopted',
        launchAgent: launchAgentToSend,
        ...(launchConfigToSend ? { launchConfig: launchConfigToSend } : {})
      }
    } catch (error) {
      transportOptions.onProviderSessionResumeFailure?.()
      throw error
    }
  }
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
    ...(launchConfigToSend ? { launchConfig: launchConfigToSend } : {}),
    ...(providerSessionToResume ? { resumeProviderSession: providerSessionToResume } : {}),
    ...((connectOptions.launchToken ?? launchToken)
      ? { launchToken: connectOptions.launchToken ?? launchToken }
      : {}),
    ...(launchAgentToSend ? { launchAgent: launchAgentToSend } : {}),
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
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(telemetry ? { telemetry } : {})
  }) as Promise<IpcPtySpawnResponse>
}
