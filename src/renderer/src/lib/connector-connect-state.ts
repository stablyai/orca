// One "Connect Linear" / "Connect GitHub" trip per host and source, as every setup surface sees it.
// The host runs the trip as its own Orca account; this window opens its page where the host's
// return reaches (a server's own page in Orca's browser) and waits on the host for its end.
import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { signedInOrcaAccount } from './signed-in-orca-account'
import { refreshBotGitHub } from './bot-github-state'
import { refreshBotLinear } from './bot-linear-state'
import { refreshConnectorLinks } from './connector-links-state'
import { connectorTripCalls } from './bot-connector-host-calls'
import { openBotHostPage } from './bot-host-page'
import { CONNECT_NOT_ROUTED } from '@/components/bots/bot-host-copy'
import type { BotRef } from './bot-hosts'
import type { HttpLinkDestination } from './browser/navigation/http-link-routing'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../../shared/connector-bot-slack-contract'
import {
  CONNECTOR_CONNECT_SOURCES,
  type ConnectorConnectSource
} from '../../../shared/connectors/connector-cloud-contract'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type {
  ConnectorConnectError,
  ConnectorConnectRedeem
} from '../../../../cloud/packages/connector-contract/src/connect-messages'

/** `linked` carries what the trip linked; the account's state is refreshed before it shows. */
export type ConnectorConnectView =
  | { status: 'idle' }
  | { status: 'waiting' }
  | { status: 'linked'; link: ConnectorConnectRedeem }
  | { status: 'failed'; error: string }

const IDLE: ConnectorConnectView = { status: 'idle' }
const EXPIRED: ConnectorConnectError = 'expired'
// A trip this window ended, or replaced with a newer one: no error to show.
const CANCELLED = 'cancelled'
// The cloud's connect session and its "Open Orca" result live this long.
const TRIP_MS = 10 * 60_000
// A dropped connection to the host retries the wait this often; the trip lives there until it expires.
const RETRY_MS = 2_000
const FAILED = { ok: false, error: BOT_SLACK_DESKTOP_ERRORS.failed } as const

/** `owner`: the surface that started the newest trip; `resume`: that owner, once its trip linked and
 *  until it takes the link to carry on from it. */
type Trip = {
  view: ConnectorConnectView
  latest: number
  owner: string | null
  resume: string | null
}

const trips = new Map<string, Trip>()
const listeners = new Set<() => void>()
// The host of the newest trip per source, which alone redeems an "Open Orca" link.
const fallbackHost = new Map<ConnectorConnectSource, ExecutionHostId>()

const tripKey = (hostId: ExecutionHostId, source: ConnectorConnectSource) => `${hostId}\0${source}`

function tripOf(hostId: ExecutionHostId, source: ConnectorConnectSource): Trip {
  const key = tripKey(hostId, source)
  let trip = trips.get(key)
  if (!trip) {
    trip = { view: IDLE, latest: 0, owner: null, resume: null }
    trips.set(key, trip)
  }
  return trip
}

function set(trip: Trip, next: ConnectorConnectView): void {
  watchSignedInAccount()
  trip.view = next
  trip.resume = next.status === 'linked' ? trip.owner : null
  listeners.forEach((listener) => listener())
}

// What a trip's link changes on the host: its linked accounts, and Linear's or GitHub's own state.
const REFRESH: Record<ConnectorConnectSource, (hostId: ExecutionHostId) => Promise<unknown>> = {
  linear: (hostId) => Promise.all([refreshBotLinear(hostId), refreshConnectorLinks(hostId)]),
  github: (hostId) => Promise.all([refreshBotGitHub(hostId), refreshConnectorLinks(hostId)]),
  slack: refreshConnectorLinks
}

async function settle(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  request: number,
  result: BotSlackResult<ConnectorConnectRedeem>
): Promise<void> {
  const trip = tripOf(hostId, source)
  if (!result.ok) {
    if (request === trip.latest) {
      set(trip, result.error === CANCELLED ? IDLE : { status: 'failed', error: result.error })
    }
    return
  }
  await REFRESH[source](hostId)
  if (request === trip.latest) {
    set(trip, { status: 'linked', link: result.value })
  }
}

/** Waits on the host, slice by slice, until the trip ends or a newer one replaces it here. */
async function waitOnHost(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  request: number,
  tripId: string
): Promise<BotSlackResult<ConnectorConnectRedeem | null>> {
  const calls = connectorTripCalls(hostId, source)
  const until = Date.now() + TRIP_MS
  while (request === tripOf(hostId, source).latest) {
    const waited = await calls.wait(tripId).catch(() => null)
    if (waited?.state === 'done') {
      return waited.result
    }
    if (Date.now() > until) {
      return { ok: false, error: EXPIRED }
    }
    if (!waited) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }
  return { ok: false, error: CANCELLED }
}

/**
 * Starts the host's trip and opens its page; `switchAccount` is "Not you?", which lets the person
 * pick another account. `bot` lends its workspace for a server's page.
 */
export async function startConnectorConnect(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  options: {
    switchAccount?: boolean
    bot?: BotRef
    /** The surface starting it, which alone carries on once it links (see useResumeAfterConnect). */
    owner?: string
    /** Where the page opened, e.g. so a dialog in front of Orca's browser can step aside. */
    onOpened?: (destination: HttpLinkDestination) => void
    /** GitHub: the trip adds access, for `workspace` if named (see ConnectorConnectStartRequest). */
    addAccess?: { workspace?: string }
    /** A host too old to add access: the trip is dropped before its page opens. */
    onOlderHost?: () => void
  } = {}
): Promise<void> {
  const trip = tripOf(hostId, source)
  const request = ++trip.latest
  trip.owner = options.owner ?? null
  set(trip, { status: 'waiting' })
  const calls = connectorTripCalls(hostId, source)
  const started = await calls.start(options.switchAccount === true, options.addAccess)
  if (!started.ok) {
    await settle(hostId, source, request, started)
    return
  }
  // A newer start replaced this one on the host meanwhile: its trip is not ours to cancel.
  if (options.addAccess && started.value.addAccess !== true) {
    if (request === trip.latest) {
      void calls.cancel()
      set(trip, IDLE)
      options.onOlderHost?.()
    }
    return
  }
  const opened = openBotHostPage(hostId, started.value.authorizeUrl, {
    bot: options.bot,
    local: 'system'
  })
  if (opened === 'unrouted') {
    void calls.cancel()
    await settle(hostId, source, request, { ok: false, error: CONNECT_NOT_ROUTED })
    return
  }
  options.onOpened?.(opened)
  fallbackHost.set(source, hostId)
  const result = await waitOnHost(hostId, source, request, started.value.tripId)
  if (!result.ok) {
    await settle(hostId, source, request, result)
    return
  }
  if (result.value !== null) {
    await settle(hostId, source, request, { ok: true, value: result.value })
    return
  }
  // No loopback on the host: the trip ends at "Open Orca", which comes back as a deep link, or not.
  setTimeout(() => {
    if (request === trip.latest) {
      set(trip, { status: 'failed', error: EXPIRED })
    }
  }, TRIP_MS)
}

/**
 * "Not you?": unlinks the account shown, then starts a trip that lets the owner pick another. The old
 * identity never shows again, even if that trip is cancelled.
 */
export async function connectAnotherAccount(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  unlink: () => Promise<BotSlackResult<undefined>>,
  options: Omit<Parameters<typeof startConnectorConnect>[2] & object, 'switchAccount'> = {}
): Promise<void> {
  const trip = tripOf(hostId, source)
  const request = ++trip.latest
  trip.owner = options.owner ?? null
  set(trip, { status: 'waiting' })
  const unlinked = await unlink().catch(() => FAILED)
  await REFRESH[source](hostId)
  if (request !== trip.latest) {
    return
  }
  if (!unlinked.ok) {
    set(trip, { status: 'failed', error: unlinked.error })
    return
  }
  await startConnectorConnect(hostId, source, { ...options, switchAccount: true })
}

/** The "Open Orca" fallback's result, redeemed at once on the host whose trip it ended. */
export async function redeemConnectorLink(
  source: ConnectorConnectSource,
  result: string
): Promise<BotSlackResult<ConnectorConnectRedeem>> {
  const hostId = fallbackHost.get(source) ?? LOCAL_EXECUTION_HOST_ID
  const trip = tripOf(hostId, source)
  const request = ++trip.latest
  set(trip, { status: 'waiting' })
  const redeemed = await connectorTripCalls(hostId, source).redeem(result)
  await settle(hostId, source, request, redeemed)
  return redeemed
}

/** Ends the trip; the browser tab is left as is, and its return is no longer listened for. */
export function cancelConnectorConnect(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource
): void {
  const trip = tripOf(hostId, source)
  trip.latest++
  set(trip, IDLE)
  void connectorTripCalls(hostId, source).cancel()
}

/** Whether `owner`'s own trip linked and it hasn't carried on from it yet. */
export function hasConnectorResume(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  owner: string
): boolean {
  return trips.get(tripKey(hostId, source))?.resume === owner
}

/** Takes `owner`'s linked trip, once: true only for the first call after its own trip linked. */
export function takeConnectorResume(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  owner: string
): boolean {
  const trip = trips.get(tripKey(hostId, source))
  if (trip?.resume !== owner) {
    return false
  }
  trip.resume = null
  return true
}

/**
 * A setup surface's sign-in trip: `start` and `anotherAccount` run it as `owner`, `onStepAside` runs
 * when its page opens in Orca's browser (behind the surface), and `onLinked` runs once when that trip,
 * and no other, links, so the surface carries on without a second click.
 */
export function useResumeAfterConnect(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  {
    owner,
    onLinked,
    onStepAside,
    away = false
  }: {
    owner: string
    onLinked: (link: ConnectorConnectRedeem) => void
    onStepAside?: () => void
    /** Stepped aside: carries on once back in view (coming back may mount the surface anew). */
    away?: boolean
  }
): {
  connect: ConnectorConnectView
  start: (options?: { switchAccount?: boolean; bot?: BotRef }) => Promise<void>
  anotherAccount: (unlink: () => Promise<BotSlackResult<undefined>>, bot?: BotRef) => Promise<void>
} {
  const connect = useConnectorConnect(hostId, source)
  useEffect(() => {
    if (!away && connect.status === 'linked' && takeConnectorResume(hostId, source, owner)) {
      onLinked(connect.link)
    }
  })
  const onOpened = (destination: HttpLinkDestination): void => {
    if (destination === 'orca-browser') {
      onStepAside?.()
    }
  }
  return {
    connect,
    start: (options = {}) => startConnectorConnect(hostId, source, { ...options, owner, onOpened }),
    anotherAccount: (unlink, bot) =>
      connectAnotherAccount(hostId, source, unlink, { bot, owner, onOpened })
  }
}

export function useConnectorConnect(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource
): ConnectorConnectView {
  return useSyncExternalStore(
    (listener) => {
      watchSignedInAccount()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => trips.get(tripKey(hostId, source))?.view ?? IDLE
  )
}

let watching = false
let shownAccount: string | null = null

// A trip on this window's own host belongs to the Orca account that started it; another starts clean.
// Starts on first use, not import: state is pristine until then, and importers may mock the store.
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
    for (const source of CONNECTOR_CONNECT_SOURCES) {
      const trip = trips.get(tripKey(LOCAL_EXECUTION_HOST_ID, source))
      if (trip) {
        trip.latest++
        trip.view = IDLE
        trip.resume = null
      }
    }
    listeners.forEach((listener) => listener())
  })
}
