// Every host's group list as a hook, apart from bot-group-catalog so tab bars can read it without the store.
import { useSyncExternalStore } from 'react'
import type { BotGroup } from '../../../shared/bots/bot-group'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { onBotsChanged } from './bots-changed-window-event'
import { botHostTarget, forEachBotHost } from './bot-hosts'
import {
  hasListedLocalBotGroups,
  publishBotGroups,
  readBotGroups,
  subscribeToBotGroupChanges
} from './bot-group-catalog-snapshot'

let watchers = 0
const requests = new Map<ExecutionHostId, number>()

/** Re-reads one host's groups; a slower earlier read never undoes a later one. */
export async function refreshBotHostGroups(hostId: ExecutionHostId): Promise<void> {
  const revision = (requests.get(hostId) ?? 0) + 1
  requests.set(hostId, revision)
  const result = await callRuntimeRpc<{ groups: BotGroup[] }>(
    botHostTarget(hostId),
    'bots.groups.list'
  )
  if (revision === requests.get(hostId)) {
    publishBotGroups(result.groups, hostId)
  }
}

/** Re-reads every listed host's groups. */
export async function refreshBotGroups(): Promise<void> {
  await forEachBotHost(({ hostId }) => refreshBotHostGroups(hostId).catch(console.error))
}

let localListing: Promise<void> | null = null
/** Settles once this machine's groups are listed, or the listing fails; callers in the meantime share it. */
export function whenLocalBotGroupsListed(): Promise<void> {
  if (hasListedLocalBotGroups()) {
    return Promise.resolve()
  }
  localListing ??= (async () => {
    // A newer read can supersede ours without it publishing, so read again until a list is published.
    for (let attempt = 0; attempt < 2 && !hasListedLocalBotGroups(); attempt++) {
      await refreshBotHostGroups(LOCAL_EXECUTION_HOST_ID)
    }
  })()
    .catch(console.error)
    .finally(() => {
      localListing = null
    })
  return localListing
}

let stopListening: (() => void) | null = null
/** Keeps the group lists read and current while the listener is subscribed. */
export function watchBotGroups(listener: () => void): () => void {
  if (watchers++ === 0) {
    stopListening = onBotsChanged(refresh, undefined, { kinds: ['groups', 'bot'] })
    void refreshBotGroups()
  }
  const stop = subscribeToBotGroupChanges(listener)
  return () => {
    stop()
    if (--watchers === 0) {
      stopListening?.()
      stopListening = null
    }
  }
}
function refresh(hostId: ExecutionHostId): void {
  void refreshBotHostGroups(hostId).catch(console.error)
}
const NO_GROUPS: readonly BotGroup[] = []
const readNoGroups = (): readonly BotGroup[] => NO_GROUPS
const subscribeToNothing = (): (() => void) => () => {}

/** Every listed host's groups; while `enabled` is false, none, and nothing is read. */
export function useBotGroups(enabled = true): readonly BotGroup[] {
  const read = enabled ? readBotGroups : readNoGroups
  return useSyncExternalStore(enabled ? watchBotGroups : subscribeToNothing, read, read)
}
