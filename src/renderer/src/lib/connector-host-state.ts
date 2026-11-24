// One account connector's state per host as Orca Cloud reports it (GitHub's link and installs, Linear's
// workspaces): read on demand, shared by every surface for that host, and followed while the owner is
// away on the provider's page. Each connector supplies only how to read it and what a change is.
import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { followProviderReturn } from './browser-return-watch'
import { hostConnectorAccount, signedInOrcaAccount } from './signed-in-orca-account'

/** `unchanged`: the last wait ran out with nothing new from the provider. */
export type ConnectorAwait = 'checking' | 'unchanged' | null

/** A running wait, so the surface that started it can stop only its own. */
export type ConnectorWait = { readonly id: number }

export type AwaitConnectorOptions = {
  /** After this long, read every SLOW_POLL_MS unless the owner just came back from the provider. */
  slowAfterMs?: number
}

// A provider sign-in lives 10 minutes; an owner or admin may take longer, and reopening asks again.
const AWAIT_MS = 10 * 60_000
const SLOW_POLL_MS = 30_000

type Host<View> = {
  view: View
  latestRequest: number
  // The newest ask still out, and the account it asked as; a surface that mounts meanwhile under
  // that account takes its answer instead of asking again.
  inFlight: { asked: Promise<View>; account: string | null } | null
  awaiting: ConnectorWait | null
  unchanged: boolean
  // The running wait's teardown: its next tick and its return listeners.
  endRunningWait: (() => void) | null
}

export function createConnectorHostState<View>({
  loading,
  ask,
  shape,
  returnUrl
}: {
  /** Before any answer, and after this window's Orca account changes. */
  loading: View
  /** One read of the host's state; never rejects. */
  ask: (hostId: ExecutionHostId) => Promise<View>
  /** What a link or an install changes; null while there is no answer to compare. */
  shape: (view: View) => string | null
  /** Where the provider's page sends the browser back, read from an answer. */
  returnUrl: (view: View) => string | null
}) {
  const hosts = new Map<ExecutionHostId, Host<View>>()
  const listeners = new Set<() => void>()
  let waitsStarted = 0

  const hostOf = (hostId: ExecutionHostId): Host<View> => {
    let host = hosts.get(hostId)
    if (!host) {
      host = {
        view: loading,
        latestRequest: 0,
        inFlight: null,
        awaiting: null,
        unchanged: false,
        endRunningWait: null
      }
      hosts.set(hostId, host)
    }
    return host
  }
  const notify = (): void => listeners.forEach((listener) => listener())

  const read = (hostId: ExecutionHostId): View => hosts.get(hostId)?.view ?? loading

  const askNow = async (hostId: ExecutionHostId): Promise<View> => {
    watchSignedInAccount()
    const host = hostOf(hostId)
    const request = ++host.latestRequest
    const next = await ask(hostId)
    if (request === host.latestRequest) {
      // A later read that finds the change ends an expired wait's "nothing new".
      if (host.unchanged && shape(next) !== shape(host.view)) {
        host.unchanged = false
      }
      host.view = next
      notify()
    }
    return host.view
  }

  /** Asks the host's cloud again; an answer to an older ask never replaces a newer one. */
  const refresh = (hostId: ExecutionHostId): Promise<View> => {
    const host = hostOf(hostId)
    const asked = askNow(hostId)
    const current = { asked, account: hostConnectorAccount(hostId) }
    host.inFlight = current
    void asked.finally(() => {
      if (host.inFlight === current) {
        host.inFlight = null
      }
    })
    return asked
  }

  const readOnShow = (hostId: ExecutionHostId): Promise<View> => {
    const { inFlight } = hostOf(hostId)
    return inFlight?.account === hostConnectorAccount(hostId) ? inFlight.asked : refresh(hostId)
  }

  const subscribe = (listener: () => void): (() => void) => {
    watchSignedInAccount()
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const readAwait = (hostId: ExecutionHostId): ConnectorAwait => {
    const host = hosts.get(hostId)
    return host?.awaiting ? 'checking' : host?.unchanged ? 'unchanged' : null
  }

  const endWait = (host: Host<View>): void => {
    host.endRunningWait?.()
    host.endRunningWait = null
    host.awaiting = null
  }

  /** Whether `wait` is still the one following its host. */
  const isWaitRunning = (hostId: ExecutionHostId, wait: ConnectorWait | null): boolean =>
    wait !== null && wait === hosts.get(hostId)?.awaiting

  /** Stops following the host (only `wait`, when given, if it is still the running one); the last read stays. */
  const stopAwaiting = (hostId: ExecutionHostId, wait?: ConnectorWait | null): void => {
    const host = hosts.get(hostId)
    if (!host || (wait !== undefined && (wait === null || wait !== host.awaiting))) {
      return
    }
    endWait(host)
    host.unchanged = false
    notify()
  }

  /**
   * One sequential poll per host, from any surface, until its link or installs change or the wait
   * expires: every 3 s (or SLOW_POLL_MS past `slowAfterMs`), and at once, then faster for a while, when
   * the owner comes back from the provider (followProviderReturn). A new wait replaces the host's
   * running one, so there is never more than one.
   */
  const awaitChange = (
    hostId: ExecutionHostId,
    waitMs = AWAIT_MS,
    options: AwaitConnectorOptions = {}
  ): ConnectorWait => {
    watchSignedInAccount()
    const host = hostOf(hostId)
    endWait(host)
    const started: ConnectorWait = { id: ++waitsStarted }
    host.awaiting = started
    host.unchanged = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let follow: ReturnType<typeof followProviderReturn> | null = null
    host.endRunningWait = () => {
      clearTimeout(timer)
      follow?.stop()
    }
    notify()
    void (async () => {
      const before = shape(host.view) ?? shape(await refresh(hostId))
      const startedAt = Date.now()
      let reading = false
      // A return while a read is out: that read may predate the provider's save, so read once more.
      let readAgain = false
      const check = (): void => {
        if (host.awaiting !== started) {
          return
        }
        if (reading) {
          readAgain = true
          return
        }
        clearTimeout(timer)
        reading = true
        readAgain = false
        void refresh(hostId).then((next) => {
          reading = false
          if (host.awaiting !== started) {
            return
          }
          const same = shape(next) === before
          if (same && readAgain) {
            check()
            return
          }
          if (same && Date.now() < startedAt + waitMs) {
            schedule()
            return
          }
          endWait(host)
          host.unchanged = same
          notify()
        })
      }
      const schedule = (): void => {
        const slow =
          options.slowAfterMs !== undefined && Date.now() - startedAt >= options.slowAfterMs
        timer = setTimeout(check, follow?.delay(slow ? SLOW_POLL_MS : undefined))
      }
      if (host.awaiting === started) {
        follow = followProviderReturn({ returnUrl: returnUrl(host.view), check })
        schedule()
      }
    })()
    return started
  }

  let watching = false
  let shownAccount: string | null = null
  // Another Orca account's state must never show as this window's own host's: it reads as loading and
  // is asked again at once. Starts on first use, not import: importers may mock the store.
  function watchSignedInAccount(): void {
    if (watching) {
      return
    }
    watching = true
    shownAccount = signedInOrcaAccount()
    useAppStore.subscribe(() => {
      const account = signedInOrcaAccount()
      if (account === shownAccount) {
        return
      }
      shownAccount = account
      const host = hosts.get(LOCAL_EXECUTION_HOST_ID)
      if (!host) {
        return
      }
      host.latestRequest++
      host.inFlight = null
      endWait(host)
      host.unchanged = false
      host.view = loading
      notify()
      if (listeners.size > 0) {
        void refresh(LOCAL_EXECUTION_HOST_ID)
      }
    })
  }

  return {
    read,
    refresh,
    subscribe,
    readAwait,
    isWaitRunning,
    stopAwaiting,
    awaitChange,
    /** The last state read, without asking the cloud again (a card on the same page asks). */
    useRead: (hostId: ExecutionHostId): View => useSyncExternalStore(subscribe, () => read(hostId)),
    /** The host's state, read fresh when shown; `shown` false only subscribes. */
    useView: (hostId: ExecutionHostId, shown = true): View => {
      const current = useSyncExternalStore(subscribe, () => read(hostId))
      useEffect(() => {
        if (shown) {
          void readOnShow(hostId)
        }
      }, [hostId, shown])
      return current
    },
    /** Whether a change is being waited for on the host, or its last wait found nothing new. */
    useAwait: (hostId: ExecutionHostId): ConnectorAwait =>
      useSyncExternalStore(subscribe, () => readAwait(hostId))
  }
}
