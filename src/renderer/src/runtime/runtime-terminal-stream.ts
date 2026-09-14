import type { GlobalSettings } from '../../../shared/global-settings-types'
import { RuntimeRpcCallError, getActiveRuntimeTarget } from './runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

export {
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId,
  type RemoteRuntimePtyIdParts
} from '../../../shared/remote-runtime-pty-id'

const LIVE_TAIL_SUBSCRIPTION_TIMEOUT_MS = 10_000

export type RuntimeTerminalDataSubscriptionOptions = {
  startAtLiveTail?: boolean
  onSnapshot?: (data: string, meta?: { pendingEscapeTailAnsi?: string }) => void
  onEnd?: () => void
  onError?: (message: string) => void
  onTransportClose?: (event: { recoverable: boolean; retryWithBackoff?: boolean }) => void
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
  options?: RuntimeTerminalDataSubscriptionOptions
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
      onSnapshot: (data, meta) => {
        options?.onSnapshot?.(data, meta)
        if (!options?.startAtLiveTail) {
          if (!options?.onSnapshot) {
            watcher(data)
          }
        }
      },
      onSubscribed: () => {
        resolveLiveTail?.()
        resolveLiveTail = null
        rejectLiveTail = null
      },
      onEnd: () => {
        rejectPendingLiveTail('Remote terminal ended before live output was ready.')
        options?.onEnd?.()
      },
      onError: (message) => {
        rejectPendingLiveTail(message)
        options?.onError?.(message)
      },
      onTransportClose: (event) => {
        rejectPendingLiveTail('Remote terminal closed before live output was ready.')
        options?.onTransportClose?.(event)
      }
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
