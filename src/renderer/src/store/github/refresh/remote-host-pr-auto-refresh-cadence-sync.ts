import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { runtimeHostContactForEntry } from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import type { AppState } from '../../types'
import {
  beginHostPRAutoRefreshCadenceRead,
  endHostPRAutoRefreshCadenceRead,
  forgetHostPRAutoRefreshCadence,
  noteHostLacksPRAutoRefresh,
  rememberHostPRAutoRefreshCadence,
  type HostPRAutoRefreshCadenceRead
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
  authority: HostPRAutoRefreshCadenceRead
}

const inFlight = new Map<string, HostRead>()

export function _hostPRAutoRefreshReadsInFlightForTests(): number {
  return inFlight.size
}

/**
 * Ask the host for its setting. One read per host at a time; a request made while one is pending
 * (the host's `settingsChanged`, regained contact) marks it dirty: its answer is not remembered, and
 * one trailing read follows so the change is never lost. A failed read keeps the last known value;
 * an answer without the setting marks the host as an older Orca that lacks it.
 * An answer is also dropped when a newer authoritative value landed meanwhile (a write from the
 * Settings control, the host being forgotten), so a slow read never reverts it. Nothing outlives
 * the read: a forgotten host keeps no state here.
 */
export function readHostPRAutoRefreshCadence(
  environmentId: string,
  reader: Reader = defaultReader
): Promise<void> {
  const pending = inFlight.get(environmentId)
  // A read begun before the host was forgotten cannot answer for it once it is paired again.
  if (pending && !pending.authority.retired) {
    pending.dirty = true
    return pending.settled
  }
  return startHostRead(environmentId, reader).settled
}

function startHostRead(environmentId: string, reader: Reader): HostRead {
  const authority = beginHostPRAutoRefreshCadenceRead(environmentId)
  const read: HostRead = { dirty: false, settled: Promise.resolve(), authority }
  read.settled = reader(environmentId)
    .then((settings) => {
      if (!read.dirty && !authority.revoked) {
        // A host that knows the setting always sends it; an answer without it is an older Orca.
        if (settings.prAutoRefresh === undefined) {
          noteHostLacksPRAutoRefresh(environmentId)
        } else {
          rememberHostPRAutoRefreshCadence(environmentId, settings.prAutoRefresh)
        }
      }
    })
    .catch((error: unknown) => {
      console.warn('Failed to read a host’s PR auto-refresh setting:', error)
    })
    .then(() => {
      endHostPRAutoRefreshCadenceRead(environmentId, authority)
      if (inFlight.get(environmentId) === read) {
        inFlight.delete(environmentId)
      }
      // A forgotten host gets no trailing read; if it is paired again it is read afresh.
      if (read.dirty && !authority.retired) {
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
