// Reads each bot host's list: one read out per host, a few paired servers at once, never a disconnected one.
import type { Bot } from '../../../shared/bot-types'
import type { BotListWaits } from '../../../shared/bots/bot-list-waits'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  botChangeConcerns,
  type BotChangeKind,
  type BotNeedsYouCounts
} from '../../../shared/bots/bot-change-scope'
import { onBotsChanged } from './bots-changed-window-event'
import {
  markBotsListFailed,
  publishBotNeedsYou,
  publishBots as publish,
  readBotHostState,
  readBotNeedsYouStaleAt,
  readLiveBotHostIds,
  type BotHostConnectorStatus
} from './bot-catalog-snapshot'
import { botHostTarget } from './bot-hosts'
import {
  botHostLinkReadCurrent,
  noteBotHostLinkRead,
  sendBotHostLinkRead
} from './bot-host-link-read'

type HostRefresh = {
  updatesInFlight: number
  // Bumped as each update starts, so a read sent before it never lands after it.
  edits: number
  reading: Promise<void> | null
  queued: Promise<void> | null
  // Reads the list again as the next counted Needs you item goes stale, so its count drops.
  staleTimer: ReturnType<typeof setTimeout> | null
}
// Per host, so a burst of changes on one host never re-reads another.
const hostRefreshes = new Map<ExecutionHostId, HostRefresh>()

function hostRefresh(hostId: ExecutionHostId): HostRefresh {
  let entry = hostRefreshes.get(hostId)
  if (!entry) {
    entry = { updatesInFlight: 0, edits: 0, reading: null, queued: null, staleTimer: null }
    hostRefreshes.set(hostId, entry)
  }
  return entry
}

// Paired servers read a few at a time, so 50 reconnecting at once never send 50 lists together.
const PAIRED_READS_AT_ONCE = 4
// A connected server that never answers gives up its slot, so it can't hold the others' reads.
export const BOTS_LIST_TIMEOUT_MS = 30_000
let pairedReads = 0
const pairedReadQueue: (() => void)[] = []

async function withPairedReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (pairedReads < PAIRED_READS_AT_ONCE) {
    pairedReads += 1
  } else {
    // A finished read hands its slot straight to the next, so the count never overshoots.
    await new Promise<void>((resolve) => pairedReadQueue.push(resolve))
  }
  try {
    return await read()
  } finally {
    const next = pairedReadQueue.shift()
    if (next) {
      next()
    } else {
      pairedReads -= 1
    }
  }
}

type BotsListAnswer = {
  bots: Bot[]
  threadReplies?: boolean
  webhooks?: boolean
  waits?: BotListWaits
  needsYou?: Record<string, number>
  needsYouAt?: number
  needsYouStaleInMs?: number
  connectorNeedsSignIn?: boolean
  connectorStatus?: BotHostConnectorStatus
}

async function readBotHost(hostId: ExecutionHostId, state: HostRefresh): Promise<void> {
  // A disconnected server keeps its last read; it reads again once it is back.
  if (readBotHostState(hostId) !== 'live') {
    return
  }
  const edits = state.edits
  const ticket = sendBotHostLinkRead(hostId)
  try {
    const read = (): Promise<BotsListAnswer> =>
      callRuntimeRpc<BotsListAnswer>(botHostTarget(hostId), 'bots.list', undefined, {
        timeoutMs: BOTS_LIST_TIMEOUT_MS
      })
    const result = await (hostId === LOCAL_EXECUTION_HOST_ID ? read() : withPairedReadSlot(read))
    // While an update is out the shown list is newer than any answer; the last one to land refreshes.
    // A read sent before the host went away answers for a host that may have changed: its re-read follows.
    if (
      state.updatesInFlight > 0 ||
      state.edits !== edits ||
      readBotHostState(hostId) === null ||
      !botHostLinkReadCurrent(hostId, ticket)
    ) {
      return
    }
    publish(
      result.bots,
      {
        threadReplies: result.threadReplies === true,
        webhooks: result.webhooks,
        waits: result.waits,
        needsYou: result.needsYou,
        needsYouAt: result.needsYouAt,
        needsYouStaleInMs: result.needsYouStaleInMs,
        connectorNeedsSignIn: result.connectorNeedsSignIn,
        connectorStatus: result.connectorStatus
      },
      hostId
    )
    noteBotHostLinkRead(hostId, true, ticket)
    readWhenNeedsYouGoesStale(hostId, state)
  } catch (error) {
    // A failure from before the host came back says nothing of its list now; its re-read follows.
    if (!botHostLinkReadCurrent(hostId, ticket)) {
      return
    }
    noteBotHostLinkRead(hostId, false, ticket)
    markBotsListFailed(hostId)
    console.error('Failed to list bots:', error)
  }
}

// setTimeout's longest wait; a later stale time waits again from there.
const MAX_TIMER_MS = 2 ** 31 - 1
// The host counts with its own clock, so the read waits a little past the item's stale time.
const STALE_READ_MARGIN_MS = 1000

function readWhenNeedsYouGoesStale(hostId: ExecutionHostId, state: HostRefresh): void {
  if (state.staleTimer) {
    clearTimeout(state.staleTimer)
    state.staleTimer = null
  }
  const staleAt = readBotNeedsYouStaleAt(hostId)
  if (staleAt === undefined) {
    return
  }
  const wait = Math.min(Math.max(staleAt - Date.now(), 0) + STALE_READ_MARGIN_MS, MAX_TIMER_MS)
  state.staleTimer = setTimeout(() => {
    state.staleTimer = null
    void refreshBotHost(hostId)
  }, wait)
}

/** The changes the bot list itself shows. */
const BOT_LIST_KINDS: readonly BotChangeKind[] = ['bot', 'automations', 'settings']

/** Re-reads a host's list on its notices. An items notice carries the host's Needs you counts, so it
 *  reads nothing; an older host's reads the list. */
export function followBotHostNotices(): () => void {
  return onBotsChanged(
    (hostId, scope) => {
      if (scope?.needsYou && !botChangeConcerns(scope, { kinds: BOT_LIST_KINDS })) {
        applyBotNeedsYou(hostId, scope.needsYou)
      } else {
        void refreshBotHost(hostId)
      }
    },
    undefined,
    { kinds: [...BOT_LIST_KINDS, 'items'] }
  )
}

function applyBotNeedsYou(hostId: ExecutionHostId, needsYou: BotNeedsYouCounts): void {
  publishBotNeedsYou(hostId, needsYou)
  readWhenNeedsYouGoesStale(hostId, hostRefresh(hostId))
}

/**
 * Re-reads one host's bots. One read per host is out at a time; every ask while it is out
 * shares one more read after it, so a burst of changes costs at most two.
 */
export function refreshBotHost(hostId: ExecutionHostId): Promise<void> {
  const state = hostRefresh(hostId)
  if (!state.reading) {
    state.reading = readBotHost(hostId, state).finally(() => {
      state.reading = null
    })
    return state.reading
  }
  state.queued ??= state.reading.then(() => {
    state.queued = null
    return refreshBotHost(hostId)
  })
  return state.queued
}

/** Re-reads every connected host's bots. */
export async function refreshBots(): Promise<void> {
  await Promise.all(readLiveBotHostIds().map((hostId) => refreshBotHost(hostId)))
}

/** Holds the host's reads back while an edit is out; the returned end re-reads once the last one lands. */
export function beginBotHostUpdate(hostId: ExecutionHostId): () => Promise<void> {
  const state = hostRefresh(hostId)
  state.updatesInFlight += 1
  state.edits += 1
  return async () => {
    state.updatesInFlight -= 1
    if (state.updatesInFlight === 0) {
      await refreshBotHost(hostId)
    }
  }
}
