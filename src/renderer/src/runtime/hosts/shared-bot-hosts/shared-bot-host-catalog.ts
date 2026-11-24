// The agents shared with this Orca account, as main publishes them. Each is a host the app reaches by
// its environment id through main's relay link rather than a paired server's connection.
import { useSyncExternalStore } from 'react'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import { BOT_SHARE_RPC_METHODS } from '../../../../../shared/bots/bot-share-rpc-methods'
import type { RuntimeRpcFailure } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { setSharedBotHostLookup } from '../../../../../shared/bots/bot-home-host'

let views: readonly SharedBotHostView[] = []
// Until main first answers, the list says nothing about which shares are gone.
let hydrated = false
const listeners = new Set<() => void>()

function setViews(next: readonly SharedBotHostView[]): void {
  views = next
  hydrated = true
  for (const listener of listeners) {
    listener()
  }
}

/** Follows main's list; a paired web window has no account of its own, so it never has any. */
export function installSharedBotHostCatalog(): () => void {
  const stop = window.api.sharedBotHosts.onChanged(setViews)
  void window.api.sharedBotHosts.list().then(setViews, () => {})
  const stopLookup = setSharedBotHostLookup(
    (environmentId) => sharedBotHostFor({ kind: 'environment', environmentId }) !== null
  )
  return () => {
    stop()
    stopLookup()
    views = []
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

/** The one routing check: whether a target is a shared agent's host, reached through main's relay link. */
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

/**
 * The one gate on what a teammate's Orca asks a shared host: a method off the share allowlist (the
 * owner's activity, suggestions, paired-server asks, status) is the host's to refuse, so it is
 * refused here with the host's own answer and never sent. Null when the host takes it.
 */
export function sharedBotHostRefusal(method: string): RuntimeRpcFailure | null {
  return BOT_SHARE_RPC_METHODS.has(method)
    ? null
    : {
        id: method,
        ok: false,
        // Read by its code, as from a host that lacks the method; never shown.
        error: { code: 'method_not_found', message: method }
      }
}

export function useSharedBotHosts(): readonly SharedBotHostView[] {
  return useSyncExternalStore(subscribeSharedBotHosts, readSharedBotHosts)
}

/** `sharedBotHostOf`, followed for its changes. */
export function useSharedBotHostOf(hostId: ExecutionHostId): SharedBotHostView | null {
  useSharedBotHosts()
  return sharedBotHostOf(hostId)
}
