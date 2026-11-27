// The agents shared with this Orca account, as main publishes them. Each is a host the app reaches by
// its environment id, as a paired server (main signs in there with the share's key).
import { useSyncExternalStore } from 'react'
import type {
  SharedBotHostsState,
  SharedBotHostView,
  SharedBotRequestView
} from '../../../../../shared/bots/shared-bot-hosts'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { setProjectsHiddenHosts } from '../../../../../shared/project/catalog/hidden-projects'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

const NO_HOSTS: readonly SharedBotHostView[] = []
const NO_REQUESTS: readonly SharedBotRequestView[] = []
let views: readonly SharedBotHostView[] = NO_HOSTS
let requests: readonly SharedBotRequestView[] = NO_REQUESTS
// Whether this account's Orca Cloud takes shares; null until it answers either way.
let sharing: boolean | null = null
// Until main first answers, the list says nothing about which shares are gone.
let hydrated = false
// Main's first answer, which catalogs listing every host wait for (none outside a desktop window).
let firstAnswer: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()
// Settles once main has said which agents are shared (a failed read never does), for readers that
// must not take "not listed yet" for "not shared".
let markListed = (): void => {}
let listed = new Promise<void>((resolve) => (markListed = resolve))
let hostsChanged: SharedBotHostsChanged = () => {}

/** Called when the set of shared hosts changes (never for a link-state change alone), with the
 *  hosts whose share ended, after their projects stop being kept out of Projects. */
export type SharedBotHostsChanged = (endedEnvironmentIds: readonly string[]) => void

function setState(next: SharedBotHostsState): void {
  const before = new Set(views.map((view) => view.environmentId))
  // A cloud that doesn't take shares has none to show, whatever was kept from before.
  views = next.sharing === false ? NO_HOSTS : next.hosts
  requests = next.sharing === false ? NO_REQUESTS : (next.requests ?? NO_REQUESTS)
  sharing = next.sharing
  hydrated = true
  markListed()
  applyHosts(before)
  for (const listener of listeners) {
    listener()
  }
}

function applyHosts(before: ReadonlySet<string>): void {
  const after = new Set(views.map((view) => view.environmentId))
  if (after.size === before.size && [...after].every((id) => before.has(id))) {
    return
  }
  setProjectsHiddenHosts(new Set([...after].map(toRuntimeExecutionHostId)))
  hostsChanged([...before].filter((id) => !after.has(id)))
}

/**
 * Follows main's list; a paired web window has no account of its own, so it never has any.
 * `onHostsChanged` is the one place the window reacts to shares arriving or ending.
 */
export function installSharedBotHostCatalog(
  onHostsChanged: SharedBotHostsChanged = () => {}
): () => void {
  hostsChanged = onHostsChanged
  const stop = window.api.sharedBotHosts.onChanged(setState)
  firstAnswer = window.api.sharedBotHosts.list().then(setState, () => {})
  return () => {
    stop()
    firstAnswer = Promise.resolve()
    const before = new Set(views.map((view) => view.environmentId))
    views = NO_HOSTS
    requests = NO_REQUESTS
    sharing = null
    hydrated = false
    listed = new Promise<void>((resolve) => (markListed = resolve))
    applyHosts(before)
    hostsChanged = () => {}
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Whether main has said which agents are shared with this account, so a missing one is gone. */
export function sharedBotHostsHydrated(): boolean {
  return hydrated
}

/** Settles once main has first answered (or failed to), so a listing of every host includes these. */
export function sharedBotHostsAnswered(): Promise<void> {
  return firstAnswer
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

/** Whether `environmentId` is a shared agent's host, once main has said which are: before then (or
 *  after a failed read) it waits, never answering "not shared". A paired web window keeps none. */
export async function isSharedBotHostOnceListed(environmentId: string): Promise<boolean> {
  if (isPairedWebClientWindow()) {
    return false
  }
  await listed
  return sharedBotHostFor({ kind: 'environment', environmentId }) !== null
}

/** Whether `environmentId` may be a shared agent's host: one listed, or any before main has said which
 *  are. A paired web window keeps no shares of its own. */
export function maybeSharedBotHost(environmentId: string): boolean {
  if (isPairedWebClientWindow()) {
    return false
  }
  return !hydrated || sharedBotHostFor({ kind: 'environment', environmentId }) !== null
}

/** The shared agent's host a bot's host id names, or null for this computer's or a paired server's. */
export function sharedBotHostOf(hostId: ExecutionHostId): SharedBotHostView | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? sharedBotHostFor({ kind: 'environment', environmentId: parsed.environmentId })
    : null
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
