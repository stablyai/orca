import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

export async function spawnIpcPty(
  transportOptions: IpcPtyTransportOptions,
  connectOptions: PtyConnectOptions,
  admittedSessionId?: string
): Promise<PtyConnectResult & { isReattach?: boolean }> {
  const {
    cwd,
    cwdFallback,
    env,
    envToDelete,
    command,
    commandDelivery,
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
    telemetry
  } = transportOptions
  const shouldSendLocalCwdFallback =
    cwdFallback === 'worktree' && !connectionId && !admittedSessionId
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
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(telemetry ? { telemetry } : {})
  }) as Promise<PtyConnectResult & { isReattach?: boolean }>
}
