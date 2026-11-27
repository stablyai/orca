import { useEffect, useId, useSyncExternalStore } from 'react'
import type { RemoteServerPaneRetries } from './remote-server-pane-retries'
import { CALM_STATUS_HEALTHY_HOLD_MS } from '../../../../../../../shared/remote-runtime/connection-status/calm-status-reveal'

/** Share one outage clock per server across a window's surfaces; the window's one card shows while a visible surface speaks, and every pane stays quiet while any notice is speaking or held on screen. */
type ServerOutage = {
  observers: Set<string>
  speakers: string[]
  showers: Set<string>
  /** Surfaces whose panes on this server all stopped retrying. */
  latched: Set<string>
  /** Surfaces with a pane on this server still retrying. */
  retrying: Set<string>
  since: number
  releaseTimer: number | null
}

const outages = new Map<string, ServerOutage>()
const listeners = new Set<() => void>()
const NO_OUTAGES: readonly string[] = []
let outageIds: readonly string[] = NO_OUTAGES

function notify(): void {
  const ids = Array.from(outages.keys())
  if (ids.length !== outageIds.length || ids.some((id, index) => id !== outageIds[index])) {
    outageIds = ids.length === 0 ? NO_OUTAGES : ids
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function outageFor(environmentId: string): ServerOutage {
  let outage = outages.get(environmentId)
  if (!outage) {
    outage = {
      observers: new Set(),
      speakers: [],
      showers: new Set(),
      latched: new Set(),
      retrying: new Set(),
      since: Date.now(),
      releaseTimer: null
    }
    outages.set(environmentId, outage)
  }
  if (outage.releaseTimer !== null) {
    window.clearTimeout(outage.releaseTimer)
    outage.releaseTimer = null
  }
  return outage
}

function releaseWhenUnused(environmentId: string): void {
  const outage = outages.get(environmentId)
  if (!outage || outage.observers.size > 0 || outage.showers.size > 0) {
    return
  }
  if (outage.releaseTimer !== null) {
    return
  }
  // Why held briefly: a tab switch unmounts one observer before the next mounts.
  outage.releaseTimer = window.setTimeout(() => {
    const current = outages.get(environmentId)
    if (current && current.observers.size === 0 && current.showers.size === 0) {
      outages.delete(environmentId)
      notify()
    }
  }, CALM_STATUS_HEALTHY_HOLD_MS)
}

function join(
  environmentId: string,
  member: string,
  role: 'observers' | 'showers' | 'latched' | 'retrying'
): () => void {
  outageFor(environmentId)[role].add(member)
  notify()
  return () => {
    outages.get(environmentId)?.[role].delete(member)
    releaseWhenUnused(environmentId)
    notify()
  }
}

function speak(environmentId: string, speaker: string): () => void {
  const outage = outageFor(environmentId)
  outage.speakers = [...outage.speakers, speaker]
  notify()
  return () => {
    const current = outages.get(environmentId)
    if (current) {
      current.speakers = current.speakers.filter((entry) => entry !== speaker)
    }
    releaseWhenUnused(environmentId)
    notify()
  }
}

export type RemoteServerNoticeClaim = {
  /** A notice for this server is up or about to be, so its panes stay quiet. */
  quiet: boolean
  /** The server's card is on screen, so its down panes are veiled. */
  showing: boolean
}

const NO_CLAIM: RemoteServerNoticeClaim = { quiet: false, showing: false }

/** `environmentId` is the surface's server; `down` is whether its shared connection is down; `canSpeak` lets this surface keep the window's card up. */
export function useRemoteServerNoticeClaim(
  environmentId: string | null,
  down: boolean,
  canSpeak: boolean
): RemoteServerNoticeClaim {
  const surface = useId()
  useEffect(
    () => (environmentId === null || !down ? undefined : join(environmentId, surface, 'observers')),
    [down, environmentId, surface]
  )
  useEffect(
    () =>
      environmentId === null || !down || !canSpeak ? undefined : speak(environmentId, surface),
    [canSpeak, down, environmentId, surface]
  )
  const speaking = useSyncExternalStore(subscribe, () =>
    environmentId === null ? false : (outages.get(environmentId)?.speakers.length ?? 0) > 0
  )
  const showing = useSyncExternalStore(subscribe, () =>
    environmentId === null ? false : (outages.get(environmentId)?.showers.size ?? 0) > 0
  )
  if (environmentId === null) {
    return NO_CLAIM
  }
  return { quiet: speaking || showing, showing }
}

/** Reports whether this surface's panes on the down server still retry, so the card can say retries stopped. */
export function useReportRemoteServerPaneRetries(
  environmentId: string | null,
  retries: RemoteServerPaneRetries
): void {
  const surface = useId()
  useEffect(
    () =>
      environmentId === null || retries === null
        ? undefined
        : join(environmentId, surface, retries),
    [environmentId, retries, surface]
  )
}

/** Publishes that this server's card is on screen, so every surface's panes wait it out. */
export function usePublishRemoteServerNoticeShowing(
  environmentId: string | null,
  showing: boolean
): void {
  const surface = useId()
  useEffect(
    () =>
      environmentId === null || !showing ? undefined : join(environmentId, surface, 'showers'),
    [environmentId, showing, surface]
  )
}

/** Servers with a live or held outage record in this window, first outage first. */
export function useRemoteServerOutageIds(): readonly string[] {
  return useSyncExternalStore(subscribe, () => outageIds)
}

export type RemoteServerOutageCardInputs = {
  /** A visible surface on this server can show the card. */
  speaking: boolean
  /** A mounted surface still sees the server down. */
  down: boolean
  /** When any surface in this window first saw the outage. */
  since: number | null
  /** Every reporting surface's panes stopped retrying. */
  stopped: boolean
}

export function useRemoteServerOutageCardInputs(
  environmentId: string
): RemoteServerOutageCardInputs {
  const speaking = useSyncExternalStore(
    subscribe,
    () => (outages.get(environmentId)?.speakers.length ?? 0) > 0
  )
  const down = useSyncExternalStore(
    subscribe,
    () => (outages.get(environmentId)?.observers.size ?? 0) > 0
  )
  const since = useSyncExternalStore(subscribe, () => outages.get(environmentId)?.since ?? null)
  const stopped = useSyncExternalStore(subscribe, () => {
    const outage = outages.get(environmentId)
    return outage !== undefined && outage.latched.size > 0 && outage.retrying.size === 0
  })
  return { speaking, down, since, stopped }
}
