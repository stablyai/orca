import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { runtimeHostContactForEntry } from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import type { AppState } from '../../types'
import {
  forgetHostPRAutoRefreshCadence,
  hostPRAutoRefreshCadenceGeneration,
  rememberHostPRAutoRefreshCadence
} from './remote-host-pr-auto-refresh-cadence'

const READ_TIMEOUT_MS = 15_000

type HostStore = {
  getState: () => Pick<AppState, 'runtimeEnvironments' | 'runtimeStatusByEnvironmentId'>
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}

type Reader = (environmentId: string) => Promise<{ prAutoRefresh?: unknown }>

const defaultReader: Reader = async (environmentId) => {
  const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
    { kind: 'environment', environmentId },
    'settings.get',
    undefined,
    { timeoutMs: READ_TIMEOUT_MS }
  )
  return result.settings
}

type HostRead = {
  /** Settles after this read and, when a change arrived during it, the trailing read too. */
  settled: Promise<void>
  /** A change was reported while the host had not answered: its answer may predate the change. */
  dirty: boolean
}

const inFlight = new Map<string, HostRead>()

/**
 * Ask the host for its setting. One read per host at a time; a request made while one is pending
 * (the host's `settingsChanged`, regained contact) marks it dirty: its answer is not remembered, and
 * one trailing read follows so the change is never lost. A failed read keeps the last known value.
 * An answer is also dropped when a newer authoritative value landed meanwhile (a write from the
 * Settings control, the host being forgotten), so a slow read never reverts it.
 */
export function readHostPRAutoRefreshCadence(
  environmentId: string,
  reader: Reader = defaultReader
): Promise<void> {
  const pending = inFlight.get(environmentId)
  if (pending) {
    pending.dirty = true
    return pending.settled
  }
  return startHostRead(environmentId, reader).settled
}

function startHostRead(environmentId: string, reader: Reader): HostRead {
  const generation = hostPRAutoRefreshCadenceGeneration(environmentId)
  const read: HostRead = { dirty: false, settled: Promise.resolve() }
  read.settled = reader(environmentId)
    .then((settings) => {
      if (!read.dirty && hostPRAutoRefreshCadenceGeneration(environmentId) === generation) {
        rememberHostPRAutoRefreshCadence(environmentId, settings.prAutoRefresh)
      }
    })
    .catch((error: unknown) => {
      console.warn('Failed to read a host’s PR auto-refresh setting:', error)
    })
    .then(() => {
      if (inFlight.get(environmentId) === read) {
        inFlight.delete(environmentId)
      }
      if (read.dirty) {
        return startHostRead(environmentId, reader).settled
      }
      return undefined
    })
  inFlight.set(environmentId, read)
  return read
}

/**
 * Keeps every paired host's PR auto-refresh cadence current: read when the host is first seen live
 * and on each regained contact (a restarted host may have another setting), forgotten when the
 * host is unpaired. A host's `settingsChanged` event re-reads it between contacts.
 */
export function installRemoteHostPRAutoRefreshCadenceSync(
  store: HostStore,
  reader: Reader = defaultReader
): () => void {
  const watched = new Map<string, () => void>()
  const readIfLive = (environmentId: string): void => {
    const entry = store.getState().runtimeStatusByEnvironmentId.get(environmentId)
    if (runtimeHostContactForEntry(entry).verdict === 'live') {
      void readHostPRAutoRefreshCadence(environmentId, reader)
    }
  }
  const reconcile = (): void => {
    const ids = new Set(store.getState().runtimeEnvironments.map((environment) => environment.id))
    for (const [environmentId, unsubscribe] of watched) {
      if (!ids.has(environmentId)) {
        unsubscribe()
        watched.delete(environmentId)
        forgetHostPRAutoRefreshCadence(environmentId)
      }
    }
    for (const environmentId of ids) {
      if (watched.has(environmentId)) {
        continue
      }
      watched.set(
        environmentId,
        subscribeRuntimeHostContactRegained(environmentId, () => readIfLive(environmentId))
      )
      readIfLive(environmentId)
    }
  }
  reconcile()
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.runtimeEnvironments !== previous.runtimeEnvironments) {
      reconcile()
    }
  })
  return () => {
    unsubscribe()
    for (const stop of watched.values()) {
      stop()
    }
    watched.clear()
  }
}
