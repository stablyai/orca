import type { GlobalSettings } from '../../../shared/types'
import { RuntimeRpcCallError, getActiveRuntimeTarget } from './runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer'

const REMOTE_PTY_ID_PREFIX = 'remote:'
const REMOTE_PTY_OWNER_SEPARATOR = '@@'
const LIVE_TAIL_SUBSCRIPTION_TIMEOUT_MS = 10_000

export type RemoteRuntimePtyIdParts = {
  environmentId: string | null
  handle: string
}

export function toRemoteRuntimePtyId(handle: string, environmentId?: string | null): string {
  const owner = environmentId?.trim()
  if (!owner) {
    return `${REMOTE_PTY_ID_PREFIX}${handle}`
  }
  return `${REMOTE_PTY_ID_PREFIX}${encodeURIComponent(owner)}${REMOTE_PTY_OWNER_SEPARATOR}${encodeURIComponent(handle)}`
}

export function parseRemoteRuntimePtyId(ptyId: string): RemoteRuntimePtyIdParts | null {
  if (!ptyId.startsWith(REMOTE_PTY_ID_PREFIX)) {
    return null
  }
  const rest = ptyId.slice(REMOTE_PTY_ID_PREFIX.length)
  const separatorIndex = rest.indexOf(REMOTE_PTY_OWNER_SEPARATOR)
  if (separatorIndex === -1) {
    return { environmentId: null, handle: rest }
  }
  try {
    return {
      environmentId: decodeURIComponent(rest.slice(0, separatorIndex)),
      handle: decodeURIComponent(rest.slice(separatorIndex + REMOTE_PTY_OWNER_SEPARATOR.length))
    }
  } catch {
    return null
  }
}

export function getRemoteRuntimeTerminalHandle(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? null
}

export function getRemoteRuntimePtyEnvironmentId(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.environmentId ?? null
}

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export async function subscribeToRuntimeTerminalData(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  clientId: string,
  watcher: (data: string) => void,
  options?: { startAtLiveTail?: boolean }
): Promise<() => void> {
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment' || !terminal) {
    return () => {}
  }

  let resolveLiveTail: (() => void) | null = null
  let rejectLiveTail: ((error: Error) => void) | null = null
  const liveTailReady = options?.startAtLiveTail
    ? new Promise<void>((resolve, reject) => {
        resolveLiveTail = resolve
        rejectLiveTail = reject
      })
    : null
  const rejectPendingLiveTail = (message: string): void => {
    rejectLiveTail?.(new Error(message))
    resolveLiveTail = null
    rejectLiveTail = null
  }

  const stream = await getRemoteRuntimeTerminalMultiplexer(target.environmentId).subscribeTerminal({
    terminal,
    client: { id: clientId, type: 'desktop' },
    callbacks: {
      onData: (data) => watcher(data),
      onSnapshot: (data) => {
        if (!options?.startAtLiveTail) {
          watcher(data)
        }
      },
      onSubscribed: () => {
        resolveLiveTail?.()
        resolveLiveTail = null
        rejectLiveTail = null
      },
      onEnd: () => rejectPendingLiveTail('Remote terminal ended before live output was ready.'),
      onError: (message) => rejectPendingLiveTail(message),
      onTransportClose: () =>
        rejectPendingLiveTail('Remote terminal closed before live output was ready.')
    }
  })

  if (liveTailReady) {
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(
      () => rejectPendingLiveTail('Timed out waiting for remote terminal live output.'),
      LIVE_TAIL_SUBSCRIPTION_TIMEOUT_MS
    )
    try {
      // Why: outcome observers must ignore historical snapshots and be armed
      // before the command whose output they classify, including over SSH.
      await liveTailReady
    } catch (error) {
      stream.close()
      throw error
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout)
        timeout = null
      }
    }
  }

  return () => stream.close()
}
