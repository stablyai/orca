// The agents shared with this Orca account, as main publishes them. Each is a host the app reaches by
// its environment id; main routes its calls over the share link rather than a paired server's connection.
import { useMemo, useSyncExternalStore } from 'react'
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
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../../../shared/workspace/identity/workspace-scope'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

const NO_HOSTS: readonly SharedBotHostView[] = []
const NO_REQUESTS: readonly SharedBotRequestView[] = []
let views: readonly SharedBotHostView[] = NO_HOSTS
let requests: readonly SharedBotRequestView[] = NO_REQUESTS
// Whether this account's Orca Cloud takes shares; null until it answers either way.
let sharing: boolean | null = null
// Until main first answers, the list says nothing about which shares are gone.
let hydrated = false
const listeners = new Set<() => void>()
// Each shared host's own id for the shared agent's home, as its listing names it (the catalog shows
// this computer's home instead), so this computer's Files can read that folder there.
const hostHomes = new Map<string, { botId: string; folderWorkspaceId: string }>()

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
    hostHomes.clear()
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

/** The folder workspace this computer keeps as the home of `botId` on `hostId`, when that is a
 *  shared agent's host and main has made it. */
export function sharedBotHomeWorkspaceId(hostId: ExecutionHostId, botId: string): string | null {
  const host = sharedBotHostOf(hostId)
  return host?.botId === botId ? host.homeWorkspaceId : null
}

/** A host's own listing of its bots: a shared host's names the shared agent's home there. */
export function noteSharedBotHostListing(
  hostId: ExecutionHostId,
  bots: readonly { id: string; folderWorkspaceId: string }[]
): void {
  const host = sharedBotHostOf(hostId)
  const bot = host ? bots.find((entry) => entry.id === host.botId) : undefined
  const known = host ? hostHomes.get(host.environmentId) : undefined
  if (
    !host ||
    !bot ||
    bot.folderWorkspaceId === host.homeWorkspaceId ||
    (known?.botId === bot.id && known.folderWorkspaceId === bot.folderWorkspaceId)
  ) {
    return
  }
  hostHomes.set(host.environmentId, { botId: bot.id, folderWorkspaceId: bot.folderWorkspaceId })
  for (const listener of listeners) {
    listener()
  }
}

/** `sharedBotHomeOnHost`, followed for its changes; the same object while its answer is the same. */
export function useSharedBotHomeOnHost(
  worktreeId: string | null | undefined
): ReturnType<typeof sharedBotHomeOnHost> {
  const key = useSyncExternalStore(subscribeSharedBotHosts, () =>
    JSON.stringify(sharedBotHomeOnHost(worktreeId))
  )
  return useMemo(() => JSON.parse(key) as ReturnType<typeof sharedBotHomeOnHost>, [key])
}

/** Where this computer's home of a shared agent reads its files: that agent's home folder on the
 *  shared host, by the host's own workspace key (null until the host has listed the agent). Null for
 *  every other workspace. */
export function sharedBotHomeOnHost(
  worktreeId: string | null | undefined
): { environmentId: string; hostWorktreeId: string | null } | null {
  const scope = worktreeId ? parseWorkspaceKey(worktreeId) : null
  const host =
    scope?.type === 'folder'
      ? views.find((view) => view.homeWorkspaceId === scope.folderWorkspaceId)
      : undefined
  if (!host) {
    return null
  }
  const home = hostHomes.get(host.environmentId)
  return {
    environmentId: host.environmentId,
    hostWorktreeId: home?.botId === host.botId ? folderWorkspaceKey(home.folderWorkspaceId) : null
  }
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
