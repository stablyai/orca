// Each listed host's last bot list, held apart from bot-catalog so store code can read it without importing the store.
import type { Bot } from '../../../shared/bot-types'
import type { BotListWait, BotListWaits } from '../../../shared/bots/bot-list-waits'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { keepBotHostList, readKeptBotHostList } from './bot-host-kept-lists'
import { reuseEqualJson } from '../../../shared/reuse-equal-json'
import type { BotNeedsYouCounts } from '../../../shared/bots/bot-change-scope'

/** What a host's bots.list says of its link to Orca Cloud (the host's ConnectorCloudStatus). */
export type BotHostConnectorStatus =
  | 'signed-out'
  | 'needs-sign-in'
  | 'unreachable'
  | 'refused'
  | 'ok'

/** A listed host is read while connected; a disconnected one keeps its last read, shown dimmed. */
export type BotHostState = 'live' | 'offline'

type BotHostEntry = {
  state: BotHostState
  bots: readonly Bot[]
  // Until the first full read, an empty list says nothing about whether the host has a bot. A list kept
  // from an earlier launch shows, but only this session's read says a bot missing from it is gone.
  listed: 'pending' | 'kept' | 'read' | 'failed'
  // Whether the host's Orca Cloud binds an event's run to its thread, from the last full read.
  threadReplies: boolean
  // Whether the host's Orca Cloud takes webhooks; undefined from an older host, which doesn't say.
  webhooks: boolean | undefined
  // Whether Orca Cloud refused the host's sign-in, so nothing reaches its bots until it signs in again.
  connectorNeedsSignIn: boolean
  // The host's link to Orca Cloud as its bots.list says it; undefined from an older host, or without Orca Cloud.
  connectorStatus: BotHostConnectorStatus | undefined
  // Each bot's waits from the last full read; an older host sends none.
  waits: BotListWaits
  // Each bot's Needs you items that aren't stale, from this session's last full read or items notice;
  // an older host sends none, and a kept list never carries them.
  needsYou: Readonly<Record<string, number>> | undefined
  // When the host counted them (its clock), so an older count landing late never replaces a newer one;
  // and when (this clock) the next counted item goes stale.
  needsYouAt: number | undefined
  needsYouStaleAt: number | undefined
}

const NO_WAITS: readonly BotListWait[] = []
const listeners = new Set<() => void>()

function emptyEntry(state: BotHostState): BotHostEntry {
  return {
    state,
    bots: [],
    listed: 'pending',
    threadReplies: false,
    webhooks: undefined,
    connectorNeedsSignIn: false,
    connectorStatus: undefined,
    waits: {},
    needsYou: undefined,
    needsYouAt: undefined,
    needsYouStaleAt: undefined
  }
}

// This computer, then each paired server that lists bots, in the server catalog's order.
const hosts = new Map<ExecutionHostId, BotHostEntry>([
  [LOCAL_EXECUTION_HOST_ID, emptyEntry('live')]
])
let hostIds: readonly ExecutionHostId[] = [...hosts.keys()]
let liveHostIds: readonly ExecutionHostId[] = hostIds
let flattened: readonly Bot[] = []
// Paired servers whose Orca is too old to list bots, for the sidebar's update line.
let updateNeeded: readonly ExecutionHostId[] = []

/** A paired server first listed this session starts from its kept last read, if any. */
function startingEntry(hostId: ExecutionHostId, state: BotHostState): BotHostEntry {
  const kept = hostId === LOCAL_EXECUTION_HOST_ID ? null : readKeptBotHostList(hostId)
  return kept
    ? {
        state,
        bots: stamp(hostId, kept.bots),
        listed: 'kept',
        threadReplies: kept.threadReplies,
        webhooks: kept.webhooks,
        connectorNeedsSignIn: kept.connectorNeedsSignIn,
        connectorStatus: kept.connectorStatus,
        waits: kept.waits,
        needsYou: undefined,
        needsYouAt: undefined,
        needsYouStaleAt: undefined
      }
    : emptyEntry(state)
}

function entryOf(hostId: ExecutionHostId): BotHostEntry | undefined {
  return hosts.get(hostId)
}

function reflatten(): void {
  // One host hands out its own list, so a read never allocates and React sees a stable value.
  flattened =
    hostIds.length === 1
      ? (entryOf(hostIds[0])?.bots ?? [])
      : hostIds.flatMap((id) => entryOf(id)?.bots ?? [])
}

/** Every bot names the host that listed it; a host stores `local` for its own bots. */
function stamp(hostId: ExecutionHostId, bots: readonly Bot[]): readonly Bot[] {
  return bots.every((bot) => bot.hostId === hostId)
    ? bots
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stored type names only the host's own `local`; the listing host is the truth here.
      bots.map((bot) => ({ ...bot, hostId }) as Bot)
}

/** A bot a host answered with, stamped with that host, as its listing would. */
export function stampBotHost(hostId: ExecutionHostId, bot: Bot): Bot {
  return stamp(hostId, [bot])[0]
}

/** An edit's optimistic list leaves the host's answer as it was. Unlisted hosts are ignored. */
export function publishBots(
  next: readonly Bot[],
  answer?: {
    threadReplies: boolean
    webhooks: boolean | undefined
    waits?: BotListWaits
    needsYou?: Readonly<Record<string, number>>
    needsYouAt?: number
    needsYouStaleInMs?: number
    connectorNeedsSignIn?: boolean
    connectorStatus?: BotHostConnectorStatus
  },
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): void {
  const entry = entryOf(hostId)
  if (!entry) {
    return
  }
  const before = entryFacts(entry)
  // An unchanged bot keeps its object, so a row of one bot never re-renders for another's change.
  entry.bots = reuseEqualJson(entry.bots, stamp(hostId, next))
  if (answer) {
    entry.listed = 'read'
    entry.threadReplies = answer.threadReplies
    entry.webhooks = answer.webhooks
    entry.waits = reuseEqualJson(entry.waits, answer.waits ?? {})
    if (!answer.needsYou) {
      // An older host never counts; this host counted before, so its count failed: keep the last.
      if (entry.needsYouAt === undefined) {
        takeNeedsYou(entry, undefined)
      }
    } else if (answer.needsYouAt === undefined) {
      // An older host doesn't say when it counted: its answer stands.
      takeNeedsYou(entry, { counts: answer.needsYou, at: -Infinity })
    } else {
      takeNeedsYou(entry, {
        counts: answer.needsYou,
        at: answer.needsYouAt,
        ...(answer.needsYouStaleInMs !== undefined ? { staleInMs: answer.needsYouStaleInMs } : {})
      })
    }
    entry.connectorNeedsSignIn = answer.connectorNeedsSignIn === true
    entry.connectorStatus = answer.connectorStatus
  }
  // An answer that changes nothing tells no one: every bot reader (sidebar, tab rows, Cmd+J, open
  // chats) would otherwise render again on each host notice.
  if (sameEntryFacts(before, entryFacts(entry))) {
    return
  }
  if (answer && hostId !== LOCAL_EXECUTION_HOST_ID) {
    keepBotHostList(hostId, {
      bots: entry.bots,
      threadReplies: entry.threadReplies,
      webhooks: entry.webhooks,
      connectorNeedsSignIn: entry.connectorNeedsSignIn,
      connectorStatus: entry.connectorStatus,
      waits: entry.waits
    })
  }
  reflatten()
  listeners.forEach((listener) => listener())
}

/** Takes the host's counts unless the entry holds a later count; none (an older host) clears them. */
function takeNeedsYou(entry: BotHostEntry, needsYou: BotNeedsYouCounts | undefined): void {
  if (!needsYou) {
    entry.needsYou = undefined
    entry.needsYouAt = undefined
    entry.needsYouStaleAt = undefined
    return
  }
  if (entry.needsYouAt !== undefined && needsYou.at < entry.needsYouAt) {
    return
  }
  entry.needsYou = reuseEqualJson(entry.needsYou, needsYou.counts)
  entry.needsYouAt = needsYou.at === -Infinity ? undefined : needsYou.at
  entry.needsYouStaleAt =
    needsYou.staleInMs !== undefined ? Date.now() + needsYou.staleInMs : undefined
}

/** An items notice's counts: the host's bots' Needs you counts change without a list read. */
export function publishBotNeedsYou(hostId: ExecutionHostId, needsYou: BotNeedsYouCounts): void {
  const entry = entryOf(hostId)
  if (!entry) {
    return
  }
  const before = entry.needsYou
  takeNeedsYou(entry, needsYou)
  if (entry.needsYou !== before) {
    listeners.forEach((listener) => listener())
  }
}

/** When (this clock) the host's next counted Needs you item goes stale; undefined for none. */
export function readBotNeedsYouStaleAt(hostId: ExecutionHostId): number | undefined {
  return entryOf(hostId)?.needsYouStaleAt
}

function entryFacts(entry: BotHostEntry): unknown[] {
  return [
    entry.bots,
    entry.listed,
    entry.threadReplies,
    entry.webhooks,
    entry.waits,
    entry.needsYou,
    entry.connectorNeedsSignIn,
    entry.connectorStatus
  ]
}

function sameEntryFacts(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.every((value, index) => Object.is(value, b[index]))
}

export type BotHostListing = {
  /** Listed hosts in sidebar order, each live or offline. */
  hosts: readonly { hostId: ExecutionHostId; state: BotHostState }[]
  updateNeeded: readonly ExecutionHostId[]
}

/**
 * Sets which hosts list bots. A new host starts from its kept last read, or unread; a dropped one
 * takes its bots with it.
 * Returns the hosts that just became live, which need a read. Nothing changes, nothing is told.
 */
export function setBotHostListing(next: BotHostListing): ExecutionHostId[] {
  const nextIds = next.hosts.map((host) => host.hostId)
  let changed =
    nextIds.length !== hostIds.length ||
    nextIds.some((id, index) => id !== hostIds[index]) ||
    next.updateNeeded.length !== updateNeeded.length ||
    next.updateNeeded.some((id, index) => id !== updateNeeded[index])
  const becameLive: ExecutionHostId[] = []
  const nextHosts = new Map<ExecutionHostId, BotHostEntry>()
  for (const { hostId, state } of next.hosts) {
    const previous = hosts.get(hostId)
    if (previous?.state !== state) {
      changed = true
      if (state === 'live') {
        becameLive.push(hostId)
      }
    }
    const entry = previous ?? startingEntry(hostId, state)
    entry.state = state
    nextHosts.set(hostId, entry)
  }
  if (!changed) {
    return becameLive
  }
  hosts.clear()
  for (const [hostId, entry] of nextHosts) {
    hosts.set(hostId, entry)
  }
  hostIds = nextIds
  liveHostIds = nextIds.filter((id) => hosts.get(id)?.state === 'live')
  updateNeeded = next.updateNeeded
  reflatten()
  listeners.forEach((listener) => listener())
  return becameLive
}

/** A first read that failed settles the question, so nothing waits on it for the session. */
export function markBotsListFailed(hostId: ExecutionHostId): void {
  const entry = entryOf(hostId)
  if (entry?.listed === 'pending') {
    entry.listed = 'failed'
    listeners.forEach((listener) => listener())
  }
}

/** Whether `hostId` answered its bot list, so a bot missing from it is gone. */
export function readBotHostListed(hostId: ExecutionHostId): boolean {
  return entryOf(hostId)?.listed === 'read'
}

/** The hosts whose bots are listed, in sidebar order, offline ones included. */
export function readBotHostIds(): readonly ExecutionHostId[] {
  return hostIds
}

/** The listed hosts that can be called now. */
export function readLiveBotHostIds(): readonly ExecutionHostId[] {
  return liveHostIds
}

/** Null for a host that lists no bots here. */
export function readBotHostState(hostId: ExecutionHostId): BotHostState | null {
  return entryOf(hostId)?.state ?? null
}

/** Paired servers whose Orca is too old to list bots. */
export function readUpdateNeededBotHosts(): readonly ExecutionHostId[] {
  return updateNeeded
}

/** Whether any host has a bot; null until every host is first read, and true if a read failed. */
export function readHasBot(): boolean | null {
  let pending = false
  for (const id of hostIds) {
    const entry = entryOf(id)
    if (entry?.listed === 'failed' || (entry && entry.bots.length > 0)) {
      return true
    }
    // A disconnected host never read yet can't answer, so it doesn't hold the others' answer back.
    pending ||= entry?.state === 'live' && entry.listed === 'pending'
  }
  return pending ? null : false
}

export function readBotThreadReplies(hostId: ExecutionHostId): boolean {
  return entryOf(hostId)?.threadReplies ?? false
}

export function readConnectorNeedsSignIn(hostId: ExecutionHostId): boolean {
  return entryOf(hostId)?.connectorNeedsSignIn ?? false
}

export function readBotHostConnectorStatus(
  hostId: ExecutionHostId
): BotHostConnectorStatus | undefined {
  return entryOf(hostId)?.connectorStatus
}

export function readBotWebhooks(hostId: ExecutionHostId): boolean | undefined {
  return entryOf(hostId)?.webhooks
}

/** The bot's waits still waiting, soonest deadline first. */
export function readBotWaits(
  bot: Pick<Bot, 'id'> & { hostId: ExecutionHostId }
): readonly BotListWait[] {
  const waits = entryOf(bot.hostId)?.waits
  return waits && Object.hasOwn(waits, bot.id) ? waits[bot.id] : NO_WAITS
}

/** Hears later changes to the list without loading it; the sidebar keeps it loaded. */
export function subscribeToBotChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every listed host's bots, for code outside React; the sidebar keeps them loaded. */
export function readBots(): readonly Bot[] {
  return flattened
}

const NO_HOST_BOTS: readonly Bot[] = []

/** One host's bots as last read; none, the same list every time, for a host that isn't listed. */
export function readHostBots(hostId: ExecutionHostId): readonly Bot[] {
  return entryOf(hostId)?.bots ?? NO_HOST_BOTS
}

/** The bot's Needs you items that aren't stale, as its host's last list read counted them; null before
 *  this session's read lands, or from an older host. */
export function readBotItemsNeedingOwner(
  bot: Pick<Bot, 'id'> & { hostId: ExecutionHostId }
): number | null {
  const counts = entryOf(bot.hostId)?.needsYou
  return counts ? (counts[bot.id] ?? 0) : null
}
