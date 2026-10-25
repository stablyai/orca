import { useEffect, useId, useSyncExternalStore } from 'react'
import { CALM_STATUS_HEALTHY_HOLD_MS } from '../../../../shared/calm-status-reveal'

/**
 * One record per server whose shared connection dropped, shared by every terminal surface on it.
 * - Observers: every mounted surface while the server is down, hidden or not, so the outage start
 *   survives a tab switch and the notice neither re-waits nor resets its clock.
 * - Speakers: visible surfaces able to show the notice; the first one shows it.
 * - Showers: surfaces whose notice is on screen, including its hold after the server answers.
 * Panes on the server stay quiet while anyone speaks or shows, so no surface's pane banners
 * overlap a notice that is still up.
 */
type ServerOutage = {
  observers: Set<string>
  speakers: string[]
  showers: Set<string>
  since: number
  releaseTimer: number | null
}

const outages = new Map<string, ServerOutage>()
const listeners = new Set<() => void>()

function notify(): void {
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

function join(environmentId: string, member: string, role: 'observers' | 'showers'): () => void {
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
  /** This surface shows the server's notice. */
  speaks: boolean
  /** A notice for this server is up or about to be, so its panes stay quiet. */
  quiet: boolean
  /** When any mounted surface first saw the outage. */
  since: number | null
}

const NO_CLAIM: RemoteServerNoticeClaim = { speaks: false, quiet: false, since: null }

/** `environmentId` is the surface's server; `down` is whether its shared connection is down. */
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
  const leader = useSyncExternalStore(subscribe, () =>
    environmentId === null ? null : (outages.get(environmentId)?.speakers[0] ?? null)
  )
  const showing = useSyncExternalStore(subscribe, () =>
    environmentId === null ? false : (outages.get(environmentId)?.showers.size ?? 0) > 0
  )
  const since = useSyncExternalStore(subscribe, () =>
    environmentId === null ? null : (outages.get(environmentId)?.since ?? null)
  )
  if (environmentId === null) {
    return NO_CLAIM
  }
  return { speaks: leader === surface, quiet: leader !== null || showing, since }
}

/** Publishes that this surface's notice is on screen, so every surface's panes wait it out. */
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

export function resetRemoteServerNoticeClaimsForTests(): void {
  for (const outage of outages.values()) {
    if (outage.releaseTimer !== null) {
      window.clearTimeout(outage.releaseTimer)
    }
  }
  outages.clear()
}
