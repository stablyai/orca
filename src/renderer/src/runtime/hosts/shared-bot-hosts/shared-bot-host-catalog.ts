// The agents shared with this Orca account, as main publishes them. Each is a host the app reaches by
// its environment id; main routes its calls over the share link rather than a paired server's connection.
import { useSyncExternalStore } from 'react'
import type {
  SharedBotHostsState,
  SharedBotHostView,
  SharedBotRequestView
} from '../../../../../shared/bots/shared-bot-hosts'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { setSharedBotHostLookup } from '../../../../../shared/bots/bot-home-host'

const NO_HOSTS: readonly SharedBotHostView[] = []
const NO_REQUESTS: readonly SharedBotRequestView[] = []
let views: readonly SharedBotHostView[] = NO_HOSTS
let requests: readonly SharedBotRequestView[] = NO_REQUESTS
// Whether this account's Orca Cloud takes shares; null until it answers either way.
let sharing: boolean | null = null
// Until main first answers, the list says nothing about which shares are gone.
let hydrated = false
const listeners = new Set<() => void>()

function setState(next: SharedBotHostsState): void {
  // A cloud that doesn't take shares has none to show, whatever was kept from before.
  views = next.sharing === false ? NO_HOSTS : next.hosts
  requests = next.sharing === false ? NO_REQUESTS : (next.requests ?? NO_REQUESTS)
  sharing = next.sharing
  hydrated = true
  for (const listener of listeners) {
    listener()
  }
}

/** Follows main's list; a paired web window has no account of its own, so it never has any. */
export function installSharedBotHostCatalog(): () => void {
  const stop = window.api.sharedBotHosts.onChanged(setState)
  void window.api.sharedBotHosts.list().then(setState, () => {})
  const stopLookup = setSharedBotHostLookup(
    (environmentId) => sharedBotHostFor({ kind: 'environment', environmentId }) !== null
  )
  return () => {
    stop()
    stopLookup()
    views = NO_HOSTS
    requests = NO_REQUESTS
    sharing = null
    hydrated = false
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Whether main has said which agents are shared with this account, so a missing one is gone. */
export function sharedBotHostsHydrated(): boolean {
  return hydrated
}

export function readSharedBotHosts(): readonly SharedBotHostView[] {
  return views
}

export function subscribeSharedBotHosts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a target is a shared agent's host, which main reaches over its share link. */
export function sharedBotHostFor(target: RuntimeClientTarget): SharedBotHostView | null {
  return target.kind === 'environment'
    ? (views.find((view) => view.environmentId === target.environmentId) ?? null)
    : null
}

/** The shared agent's host a bot's host id names, or null for this computer's or a paired server's. */
export function sharedBotHostOf(hostId: ExecutionHostId): SharedBotHostView | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? sharedBotHostFor({ kind: 'environment', environmentId: parsed.environmentId })
    : null
}

/** The folder workspace this computer keeps as the home of `botId` on `hostId`, when that is a
 *  shared agent's host and main has made it. */
export function sharedBotHomeWorkspaceId(hostId: ExecutionHostId, botId: string): string | null {
  const host = sharedBotHostOf(hostId)
  return host?.botId === botId ? host.homeWorkspaceId : null
}

/** The one gate on every sharing entry: true only once this account's Orca Cloud answered its shares
 *  route, so an older cloud (or none, or a paired web window) never offers sharing that would fail. */
export function readTeamSharingOffered(): boolean {
  return sharing === true
}

export function useTeamSharingOffered(): boolean {
  return useSyncExternalStore(subscribeSharedBotHosts, readTeamSharingOffered)
}

/** The shares offered to this account that wait for its Accept or Decline. */
export function useSharedBotRequests(): readonly SharedBotRequestView[] {
  return useSyncExternalStore(subscribeSharedBotHosts, () => requests)
}

export function useSharedBotHosts(): readonly SharedBotHostView[] {
  return useSyncExternalStore(subscribeSharedBotHosts, readSharedBotHosts)
}

/** `sharedBotHostOf`, followed for its changes. */
export function useSharedBotHostOf(hostId: ExecutionHostId): SharedBotHostView | null {
  useSharedBotHosts()
  return sharedBotHostOf(hostId)
}
