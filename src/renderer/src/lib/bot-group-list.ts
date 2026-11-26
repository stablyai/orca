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
export function refreshBotHostGroups(hostId: ExecutionHostId): Promise<void> {
  const read = readBotHostGroups(hostId)
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    localRead = read
    const clear = (): void => {
      if (localRead === read) {
        localRead = null
      }
    }
    read.then(clear, clear)
  }
  return read
}

// This machine's newest group read while it is pending.
let localRead: Promise<void> | null = null

async function readBotHostGroups(hostId: ExecutionHostId): Promise<void> {
  const revision = (requests.get(hostId) ?? 0) + 1
  requests.set(hostId, revision)
  const result = await callRuntimeRpc<{ groups: BotGroup[] }>(
    botHostTarget(hostId),
    'bots.groups.list',
    { includeReplyPreviews: true }
  )
  if (revision === requests.get(hostId)) {
    publishBotGroups(result.groups, hostId)
  }
}

/** Re-reads every listed host's groups. */
export async function refreshBotGroups(): Promise<void> {
  await forEachBotHost(({ hostId }) => refreshBotHostGroups(hostId).catch(console.error))
}

/** Settles true once this machine's groups are published, false if the latest read for them fails. */
export function whenLocalBotGroupsListed(): Promise<boolean> {
  if (hasListedLocalBotGroups()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const finish = (listed: boolean): void => {
      stop()
      resolve(listed)
    }
    const stop = subscribeToBotGroupChanges(() => {
      if (hasListedLocalBotGroups()) {
        finish(true)
      }
    })
    // Follows whichever read is newest, so a read another caller started is joined, never repeated.
    const follow = (read: Promise<void>): void => {
      const next = (): void => {
        const newer = localRead && localRead !== read ? localRead : null
        if (hasListedLocalBotGroups()) {
          finish(true)
        } else if (newer) {
          follow(newer)
        } else {
          finish(false)
        }
      }
      read.then(next, next)
    }
    follow(localRead ?? refreshBotHostGroups(LOCAL_EXECUTION_HOST_ID))
  })
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
