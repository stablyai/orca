// Bot items: what a bot is doing for its owner and what it needs from them. One list per host; each
// item belongs to one bot and one of its chats. The host's store is the truth; this is the wire shape.
import type { BotItemDecision } from './bot-item-ask'

export const BOT_ITEM_STATUSES = ['planned', 'working', 'needs_you', 'done', 'canceled'] as const
export type BotItemStatus = (typeof BOT_ITEM_STATUSES)[number]

export const BOT_ITEM_OPEN_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'needs_you']

export function isOpenBotItemStatus(status: BotItemStatus): boolean {
  return BOT_ITEM_OPEN_STATUSES.includes(status)
}

/** Refused writes, by code: an item that isn't there, a closed item's fields, a field write from a bot
 *  that doesn't own it, a file a newer Orca changed, and a snooze from a view the bot has since changed. */
export const BOT_ITEM_ERROR_CODES = [
  'not_found',
  'item_closed',
  'not_owner',
  'items_read_only',
  'items_unavailable',
  'item_changed',
  // From hosts that recorded answers (v1.4.265); this host no longer refuses with it.
  'question_closed'
] as const
export type BotItemErrorCode = (typeof BOT_ITEM_ERROR_CODES)[number] | 'invalid_argument'

/** Item writes act as the calling bot chat, so the CLI sends its session and the host verifies it. */
export const BOT_ITEM_WRITE_METHOD_NAMES = [
  'bots.items.add',
  'bots.items.set',
  'bots.items.comment',
  'bots.items.done',
  'bots.items.cancel',
  'bots.items.link'
] as const

/** Longer text is refused, so details go in a file the item links. */
export const BOT_ITEM_LIMITS = {
  title: 200,
  description: 20_000,
  doneMeans: 2_000,
  text: 8_000,
  links: 50,
  listPage: 50,
  listPageMax: 100,
  eventsPage: 50
} as const

export const BOT_ITEM_LINK_KINDS = ['dispatch', 'pr', 'url', 'file'] as const
export type BotItemLinkKind = (typeof BOT_ITEM_LINK_KINDS)[number]

export type BotItemChatKind = 'home' | 'chat' | 'thread' | 'automation'

/** A worker's state as the item sees it: `unknown` when orchestration can't be read, `missing` when its
 *  records are gone; neither is evidence of success or failure. */
export type BotItemWorkerState =
  | 'working'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown'
  | 'missing'

/** A linked worker that may still be working: running, or unreadable. */
export function isLiveBotItemWorker(state: BotItemWorkerState): boolean {
  return state === 'working' || state === 'unknown'
}

/** An item with a linked worker that may still be working: its In progress glyph spins. */
export function isBotItemLive(item: Pick<BotItem, 'links'>): boolean {
  return item.links.some((link) => link.kind === 'dispatch' && isLiveBotItemWorker(link.state))
}

export type BotItemPullRequest =
  | {
      shown: true
      ref: string
      number: number
      url: string
      state: 'open' | 'draft' | 'merged' | 'closed'
      checks: string | null
      review: string | null
      /** The cache's title; absent from hosts before titles were passed. */
      title?: string | null
      /** When the host's PR cache read it: never passed off as live. */
      checkedAt: number | null
      /** The host's worktree the PR is read for (a local worker's), so a desktop showing it can
       *  re-read it once it is stale; absent for a PR linked on its own. */
      worktreeId?: string | null
    }
  /** Server-hosted work: no remote PR read yet. */
  | { shown: false; reason: 'server' }

export type BotItemIssue = { title: string; state: 'open' | 'closed' }

export type BotItemLinkView =
  | {
      kind: 'dispatch'
      ref: string
      /** The lineage's newest Dispatch, when a follow-up continued the linked one. */
      latest: string | null
      title: string | null
      state: BotItemWorkerState
      host: string | null
      /** Activity read from orchestration's own records, never copied onto the item. */
      startedAt: number | null
      settledAt: number | null
      /** The report the worker ended with: its result. */
      report: { subject: string; body: string | null } | null
      pr: BotItemPullRequest | null
    }
  | { kind: 'pr'; ref: string; pr: BotItemPullRequest | null }
  /** `issue`: a GitHub issue link the host's issue cache has read. */
  | { kind: 'url'; ref: string; issue?: BotItemIssue }
  | { kind: 'file'; ref: string }

/** One link per worker: a bot can link several steps of one follow-up chain, and each step reads as the
 *  chain's newest Dispatch, so all but the first are the same worker again. */
export function botItemLinksOnePerChain(links: readonly BotItemLinkView[]): BotItemLinkView[] {
  const chains = new Set<string>()
  return links.filter((link) => {
    if (link.kind !== 'dispatch') {
      return true
    }
    const chain = link.latest ?? link.ref
    if (chains.has(chain)) {
      return false
    }
    chains.add(chain)
    return true
  })
}

export type BotItemActor =
  | { kind: 'bot'; botId: string; chatId: string }
  | { kind: 'owner'; device?: string }
  | { kind: 'orca'; why: string }

export const BOT_ITEM_EVENT_KINDS = [
  'made',
  'edited',
  'status',
  'commented',
  'linked',
  'snoozed',
  'unsnoozed'
] as const
export type BotItemEventKind = (typeof BOT_ITEM_EVENT_KINDS)[number]

/** Files besides images on one comment, as `bot reply --file` takes. */
export const BOT_ITEM_COMMENT_FILE_MAX_COUNT = 10

/** An image on a comment: a committed chat attachment on the bot's host, named and sized there. */
export type BotItemCommentImage = { path: string; name: string; bytes: number }

/** A `commented` event's images, dropping any entry a newer or damaged record shaped otherwise. */
export function botItemCommentImages(data: Record<string, unknown>): BotItemCommentImage[] {
  return Array.isArray(data.images)
    ? data.images.flatMap((image: unknown) =>
        typeof image === 'object' &&
        image !== null &&
        'path' in image &&
        typeof image.path === 'string' &&
        'name' in image &&
        typeof image.name === 'string' &&
        'bytes' in image &&
        typeof image.bytes === 'number'
          ? [{ path: image.path, name: image.name, bytes: image.bytes }]
          : []
      )
    : []
}

export type BotItemEvent = {
  id: string
  kind: BotItemEventKind
  actor: BotItemActor
  data: Record<string, unknown>
  at: number
}

export type BotItem = {
  uid: string
  number: number
  owner: { botId: string; name: string | null }
  title: string
  description: string | null
  doneMeans: string | null
  status: BotItemStatus
  /** `gone`: the host read its chats and this one's record is deleted, so its comments take no attachments. */
  chat: { id: string; kind: BotItemChatKind; title: string | null; gone?: true }
  madeBy: { botId: string; name: string | null; chatId: string } | null
  /** Needs you: the agent's comment asking the owner. `gist`: its body's first line; `decisions`: its
   *  question lines (`--ask`) and their quick replies (`--option`). */
  question: { eventId: string; text: string; gist?: string; decisions?: BotItemDecision[] } | null
  closeNote: string | null
  links: BotItemLinkView[]
  version: number
  lastEventId: string
  /** The newest event anyone but the owner made: what the Items tab's unseen mark compares. */
  othersLastEventId: string
  /** Hidden from its group until then, keeping its status; past, it is back. Null: not snoozed. */
  snoozedUntil: number | null
  lastActivityAt: number
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

/** How the Items list and item view show an item's number: `#35`. */
export function formatBotItemNumber(number: number): string {
  return `#${number}`
}

export function botItemEventId(id: number): string {
  return `e${id}`
}

/** `e41` or `41`; null for anything else. */
export function parseBotItemEventId(value: string): number | null {
  const match = /^e?(\d+)$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

/** A PR ref as people write it: `owner/repo#41230`. */
export function parseBotItemPrRef(value: string): { repo: string; number: number } | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value.trim())
  return match ? { repo: match[1]!, number: Number(match[2]) } : null
}

export function botItemPrUrl(ref: string): string | null {
  const parsed = parseBotItemPrRef(ref)
  return parsed ? `https://github.com/${parsed.repo}/pull/${parsed.number}` : null
}

/** `owner/repo#n` for a GitHub pull request URL; null for anything else. */
export function botItemPrRefOfUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
    url.trim()
  )
  return match ? `${match[1]}#${match[2]}` : null
}

export const BOT_ITEM_STALE_DAY_CHOICES = [3, 5, 7, 14] as const
export const BOT_ITEM_DEFAULT_STALE_DAYS = 5
/** Planned items wait this many times longer before they are stale. */
export const BOT_ITEM_PLANNED_STALE_FACTOR = 3

const DAY_MS = 24 * 60 * 60_000

/** When a Needs you item untouched since `activityAt` goes stale. */
export function botItemNeedsYouStaleAt(activityAt: number, staleDays: number): number {
  return activityAt + staleDays * DAY_MS
}

/** Snoozed is derived, never a status: an open item whose wake time hasn't come. */
export function isBotItemSnoozed(
  item: Pick<BotItem, 'status' | 'snoozedUntil'>,
  now: number
): boolean {
  return isOpenBotItemStatus(item.status) && item.snoozedUntil !== null && item.snoozedUntil > now
}

/** What the row's age, its order and the stale clock count from: its last activity, or the time it
 *  came back from a snooze when that is later. */
export function botItemActivityAt(
  item: Pick<BotItem, 'lastActivityAt' | 'snoozedUntil'>,
  now: number
): number {
  return item.snoozedUntil !== null && item.snoozedUntil <= now
    ? Math.max(item.lastActivityAt, item.snoozedUntil)
    : item.lastActivityAt
}

/**
 * Stale is derived, never a status: Needs you, or In progress with no live linked worker, untouched for the
 * bot's stale days; Planned for three times that. `null` days: never. A snoozed item is not stale.
 */
export function isBotItemStale(
  item: Pick<BotItem, 'status' | 'lastActivityAt' | 'snoozedUntil' | 'links'>,
  staleDays: number | null,
  now: number
): boolean {
  if (staleDays === null || isBotItemSnoozed(item, now)) {
    return false
  }
  const idle = now - botItemActivityAt(item, now)
  switch (item.status) {
    case 'needs_you':
      return idle >= staleDays * DAY_MS
    case 'working':
      return (
        idle >= staleDays * DAY_MS &&
        !item.links.some((link) => link.kind === 'dispatch' && isLiveBotItemWorker(link.state))
      )
    case 'planned':
      return idle >= staleDays * BOT_ITEM_PLANNED_STALE_FACTOR * DAY_MS
    case 'done':
    case 'canceled':
      return false
  }
}
