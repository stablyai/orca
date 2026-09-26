import { useSyncExternalStore } from 'react'
import type {
  CcSyncList,
  CcSyncStatus
} from '../../../../shared/cross-machine-recovery-provider-types'
import type { CrossMachineRecoveryProviderResult } from '../../../../shared/cross-machine-recovery-provider-ipc'

export type CrossMachineRecoverySnapshot = Readonly<{
  status: CrossMachineRecoveryProviderResult<CcSyncStatus> | null
  list: CrossMachineRecoveryProviderResult<CcSyncList> | null
  loading: boolean
}>

const EMPTY: CrossMachineRecoverySnapshot = { status: null, list: null, loading: false }
let snapshot: CrossMachineRecoverySnapshot = EMPTY
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: CrossMachineRecoverySnapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCrossMachineRecoverySnapshot(): CrossMachineRecoverySnapshot {
  return snapshot
}

// Why: an IPC rejection (no handler, a throwing handler) is a failed read, not an answer.
async function settleRead<T>(
  read: () => Promise<CrossMachineRecoveryProviderResult<T>>
): Promise<CrossMachineRecoveryProviderResult<T>> {
  try {
    return await read()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'provider-failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/** One provider read at a time; the dialog and the status bar share whichever answer lands. */
export function refreshCrossMachineRecovery(): Promise<void> {
  inFlight ??= (async () => {
    publish({ ...snapshot, loading: true })
    const api = window.api.crossMachineRecovery
    const [status, list] = await Promise.all([
      settleRead(() => api.status()),
      settleRead(() => api.list())
    ])
    publish({ status, list, loading: false })
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

export function useCrossMachineRecoverySnapshot(): CrossMachineRecoverySnapshot {
  return useSyncExternalStore(
    subscribe,
    getCrossMachineRecoverySnapshot,
    getCrossMachineRecoverySnapshot
  )
}

/** @internal - tests need a clean module between cases. */
export function _resetCrossMachineRecoverySnapshot(): void {
  snapshot = EMPTY
  inFlight = null
  listeners.clear()
}
