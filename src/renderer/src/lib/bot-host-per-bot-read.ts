// A value per bot that each bot host keeps (new Up next suggestions, own chats), for the
// bot's sidebar row: one read per host on first use and again on its host's botsChanged.
import { useSyncExternalStore } from 'react'
import {
  botChangeBotIds,
  type BotChangeKind,
  type BotChangeScope
} from '../../../shared/bots/bot-change-scope'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { onBotsChanged } from './bots-changed-window-event'
import { botHostTarget, forEachBotHost, type BotRef } from './bot-hosts'

type ByBot<T> = Readonly<Record<string, T>>

export type BotHostPerBotRead<T> = {
  /** The bot's value; undefined when none, or from a host without the method. */
  useValue: (bot: BotRef | null) => T | undefined
  /** Reads the host's values again now. */
  read: (hostId: ExecutionHostId) => Promise<void>
}

/** What a host's next read covers: every bot, or only the bots a notice named. */
type Wanted = 'all' | ReadonlySet<string>

const joinWanted = (a: Wanted | null, b: Wanted): Wanted =>
  a === null ? b : a === 'all' || b === 'all' ? 'all' : new Set([...a, ...b])

/** `method` answers every bot's value on its host; `pick` takes them out of the answer. */
export function createBotHostPerBotRead<T, Answer>(args: {
  method: string
  /** The kinds of change that can move the values. */
  kinds: readonly BotChangeKind[]
  pick: (answer: Answer) => ByBot<T>
  /** An unchanged answer keeps the last one, so rows that read it don't re-render. */
  same: (a: T, b: T) => boolean
  /** The method answers `{ botIds }` for those bots only, so a notice naming bots reads only them. An
   *  older host answers every bot; only the named ones are taken. */
  scoped?: { maxIds: number }
}): BotHostPerBotRead<T> {
  const { method, kinds, pick, same, scoped } = args
  // Keyed by host, then bot id: ids are random per host.
  let byHost: ReadonlyMap<ExecutionHostId, ByBot<T>> = new Map()
  // One read in flight per host; what is asked meanwhile joins a single read after it, so every
  // notice is answered by a read that started after it and no host is read twice at once.
  const reads = new Map<ExecutionHostId, { next: Wanted | null; done: Promise<void> }>()
  // A failed read may have left any bot stale: the host's next read is every bot's.
  const owesAll = new Set<ExecutionHostId>()
  const listeners = new Set<() => void>()
  let stopListening: (() => void) | null = null

  const sameAll = (a: ByBot<T> | undefined, b: ByBot<T>) => {
    if (!a) {
      return false
    }
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => {
        const [x, y] = [a[key], b[key]]
        return x !== undefined && y !== undefined && same(x, y)
      })
    )
  }

  const readOnce = async (hostId: ExecutionHostId, wanted: Wanted): Promise<void> => {
    try {
      const params = wanted === 'all' ? undefined : { botIds: [...wanted] }
      const answer = pick(await callRuntimeRpc<Answer>(botHostTarget(hostId), method, params))
      const kept = byHost.get(hostId)
      let values = answer
      if (wanted !== 'all') {
        const merged: Record<string, T> = { ...kept }
        for (const botId of wanted) {
          const value = answer[botId]
          if (value === undefined) {
            delete merged[botId]
          } else {
            merged[botId] = value
          }
        }
        values = merged
      }
      if (wanted === 'all') {
        owesAll.delete(hostId)
      }
      if (sameAll(kept, values)) {
        return
      }
      byHost = new Map(byHost).set(hostId, values)
      listeners.forEach((listener) => listener())
    } catch {
      owesAll.add(hostId)
    }
  }

  // Every bot until the host has an answer (a named read can't drop removed bots), after a failure,
  // or once joined notices name more bots than one read may.
  const coverage = (hostId: ExecutionHostId, next: Wanted): Wanted =>
    next === 'all' ||
    !byHost.has(hostId) ||
    owesAll.has(hostId) ||
    !scoped ||
    next.size > scoped.maxIds
      ? 'all'
      : next

  const readFor = (hostId: ExecutionHostId, wanted: Wanted): Promise<void> => {
    const running = reads.get(hostId)
    if (running) {
      running.next = joinWanted(running.next, wanted)
      return running.done
    }
    const state: { next: Wanted | null; done: Promise<void> } = {
      next: wanted,
      done: Promise.resolve()
    }
    reads.set(hostId, state)
    state.done = (async () => {
      for (let next = state.next; next; next = state.next) {
        state.next = null
        await readOnce(hostId, coverage(hostId, next))
      }
      reads.delete(hostId)
    })()
    return state.done
  }

  const read = (hostId: ExecutionHostId): Promise<void> => readFor(hostId, 'all')

  const readChanged = (hostId: ExecutionHostId, scope: BotChangeScope | undefined): void => {
    const botIds = botChangeBotIds(scope, kinds)
    if (botIds?.length === 0) {
      return
    }
    void readFor(hostId, scoped && botIds ? new Set(botIds) : 'all')
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (listeners.size === 1) {
      stopListening = onBotsChanged(readChanged, undefined, { kinds })
      void forEachBotHost(({ hostId }) => read(hostId))
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        stopListening?.()
        stopListening = null
      }
    }
  }
  const snapshot = (): ReadonlyMap<ExecutionHostId, ByBot<T>> => byHost

  return {
    useValue: (bot) => {
      const all = useSyncExternalStore(subscribe, snapshot, snapshot)
      return bot ? all.get(bot.hostId)?.[bot.id] : undefined
    },
    read
  }
}

export type BotHostUnseenCounts = {
  /** The bot's count; 0 when none, or from a host without the method. */
  useCount: (bot: BotRef | null) => number
  read: (hostId: ExecutionHostId) => Promise<void>
}

/** `method` answers `{ unseen: Record<botId, number> }` for every bot on its host. */
export function createBotHostUnseenCounts(
  method: string,
  kinds: readonly BotChangeKind[]
): BotHostUnseenCounts {
  const counts = createBotHostPerBotRead<number, { unseen: Record<string, number> }>({
    method,
    kinds,
    pick: (answer) => answer.unseen,
    same: (a, b) => a === b
  })
  return { useCount: (bot) => counts.useValue(bot) ?? 0, read: counts.read }
}
