// The agents shared with this Orca account, as main publishes them. Each is a host the app reaches by
// its environment id through main's relay link rather than a paired server's connection.
import { useSyncExternalStore } from 'react'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

let views: readonly SharedBotHostView[] = []
const listeners = new Set<() => void>()

function setViews(next: readonly SharedBotHostView[]): void {
  views = next
  for (const listener of listeners) {
    listener()
  }
}

/** Follows main's list; a paired web window has no account of its own, so it never has any. */
export function installSharedBotHostCatalog(): () => void {
  const stop = window.api.sharedBotHosts.onChanged(setViews)
  void window.api.sharedBotHosts.list().then(setViews, () => {})
  return () => {
    stop()
    setViews([])
  }
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

export function useSharedBotHosts(): readonly SharedBotHostView[] {
  return useSyncExternalStore(subscribeSharedBotHosts, readSharedBotHosts)
}

/** The shared agent's host a bot's host id names, or null for this computer's or a paired server's. */
export function useSharedBotHostOf(hostId: ExecutionHostId): SharedBotHostView | null {
  const parsed = parseExecutionHostId(hostId)
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
  const hosts = useSharedBotHosts()
  return environmentId === null
    ? null
    : (hosts.find((view) => view.environmentId === environmentId) ?? null)
}
