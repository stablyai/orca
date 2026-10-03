import { useAppStore } from '@/store'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

/**
 * Whether this spawn's tab is incognito ("no-session"). Read from the stamped tab so the daemon
 * spawn suppresses scrollback / sets ORCA_INCOGNITO / adds --no-session on EVERY renderer-backed
 * launch — the foreground UI path, not just CLI/background. Covers fresh spawn, reattach, restart.
 */
function resolveSpawnIncognito(options: IpcPtyTransportOptions): boolean {
  if (typeof options.incognito === 'boolean') {
    return options.incognito
  }
  if (!options.worktreeId || !options.tabId) {
    return false
  }
  try {
    const tab = useAppStore
      .getState()
      .tabsByWorktree[options.worktreeId]?.find((entry) => entry.id === options.tabId)
    return tab?.incognito === true
  } catch {
    return false
  }
}

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
  const incognito = resolveSpawnIncognito(transportOptions)
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
    ...(incognito ? { incognito: true } : {}),
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
