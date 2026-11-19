// What a Chats tree shows of the host's read, the same on the desktop panel and the phone.
import {
  CHAT_TREE_CAPS,
  botOwnChatTree,
  chatIsGoing,
  type BotChatTreeChat,
  type BotChatTreeWorker
} from './bot-chat-tree'
import { CONNECTOR_SOURCE_NAMES } from '../connectors/external-conversation-link'
import type { BotChatSearchResult } from './bot-chat-search'
import { isBotGroupMemberSession } from './bot-group'

/** A chat a search found; `matches` lists only the workers that hit when the chat itself didn't. */
export type BotChatSearchHit = { chat: BotChatTreeChat; matches: ReadonlySet<string> | null }

/** A search over the chats read here, for a host without `bots.chats.search`: a chat matches by its
 *  title or place; one matched only by workers lists just those. */
export function searchBotChats(
  chats: readonly BotChatTreeChat[],
  query: string
): BotChatSearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return chats.map((chat) => ({ chat, matches: null }))
  }
  const hit = (text: string | undefined): boolean =>
    Boolean(text?.toLocaleLowerCase().includes(needle))
  return chats.flatMap((chat): BotChatSearchHit[] => {
    if (hit(chat.title) || hit(chat.originLabel)) {
      return [{ chat, matches: null }]
    }
    const workers = [...chat.running, ...chat.finished].filter(
      (worker) => hit(worker.title) || hit(worker.branch)
    )
    return workers.length > 0 ? [{ chat, matches: new Set(workers.map((w) => w.key)) }] : []
  })
}

/** How many of a chat's running and finished workers show; starts at the caps. */
export type BotChatTreeShown = { running: number; finished: number }

export const BOT_CHAT_TREE_FIRST_SHOWN: BotChatTreeShown = {
  running: CHAT_TREE_CAPS.runningShown,
  finished: CHAT_TREE_CAPS.finishedShown
}

export type BotChatTreeSlice = {
  running: BotChatTreeWorker[]
  finished: BotChatTreeWorker[]
  /** Running workers past the shown ones. */
  moreRunning: number
  /** Finished workers past the shown ones. */
  earlier: number
  /** A step was taken, so "Show fewer" applies. */
  stepped: boolean
}

/** A chat's workers as shown: waiting on the owner first, capped, or only a search's matches. */
export function botChatTreeSlice(
  chat: BotChatTreeChat,
  shown: BotChatTreeShown,
  matches: ReadonlySet<string> | null
): BotChatTreeSlice {
  const keep = (worker: BotChatTreeWorker): boolean => !matches || matches.has(worker.key)
  const running = [...chat.running]
    .sort((a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you'))
    .filter(keep)
  const finished = chat.finished.filter(keep)
  if (matches) {
    return { running, finished, moreRunning: 0, earlier: 0, stepped: false }
  }
  const shownRunning = running.slice(0, shown.running)
  const shownFinished = finished.slice(0, shown.finished)
  return {
    running: shownRunning,
    finished: shownFinished,
    moreRunning: chat.runningTotal - shownRunning.length,
    earlier: chat.finishedTotal - shownFinished.length,
    stepped:
      shown.running > BOT_CHAT_TREE_FIRST_SHOWN.running ||
      shown.finished > BOT_CHAT_TREE_FIRST_SHOWN.finished
  }
}

/** More than a step remains, so the link reads "Show 8 more · N …" rather than "Show N …". */
export function botChatTreeStepIsPartial(remaining: number): boolean {
  return remaining > CHAT_TREE_CAPS.step
}

/** The next step of finished workers, and whether the host must be asked for them first. */
export function nextFinishedStep(
  chat: BotChatTreeChat,
  shownFinished: number
): { shown: number; read: boolean } {
  const shown = shownFinished + CHAT_TREE_CAPS.step
  return { shown, read: chat.finished.length < Math.min(shown, chat.finishedTotal) }
}

/** A chat with workers starts folded, live or not; a search or the owner's unfold opens it. */
export function botChatIsOpen(
  chat: BotChatTreeChat,
  fold: 'open' | 'folded' | undefined,
  searching: boolean
): boolean {
  const hasWorkers = chat.runningTotal + chat.finishedTotal > 0
  return hasWorkers && (searching || fold === 'open')
}

export type BotChatListView = {
  /** The rows to draw: the first pages of chats in order, or a search's hits. */
  found: BotChatSearchHit[]
  /** Chats past the pages shown; closed ones come last, so they fold into these. */
  older: number
  /** Only an unstarted Home Chat so far, which gets the explainer line. */
  onlyHome: boolean
  /** A search found nothing. */
  noMatch: boolean
  /** A search couldn't run, which is not the same as no match. */
  searchFailed: boolean
  /** Chats a search matched past the ones it lists. */
  moreMatches: number
}

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botChatMoreMatchesNote(t: Translate, count: number): string {
  return t(
    'bots.chats.moreMatches',
    '{{count}} more matches. Search for more of a name to narrow it.',
    {
      count,
      defaultValue_one: '{{count}} more match. Search for more of a name to narrow it.'
    }
  )
}

/** A host's search answer as rows: each chat, and the workers that hit when the chat itself didn't.
 *  Only the answer shows, shaped as the list is (`botOwnChatTree`): a group room session's matched
 *  workers sit under Home Chat. With no Home in the answer, the list's `home` lends only its header. */
export function botChatSearchHits(
  result: BotChatSearchResult,
  home: BotChatTreeChat | null = null
): BotChatSearchHit[] {
  const answerHome = result.chats.find((chat) => chat.origin === 'home' && !chat.closed)
  const roomHit = result.matches.some((match) => isBotGroupMemberSession(match.chatId))
  const header =
    !answerHome && roomHit && home
      ? { ...home, running: [], runningTotal: 0, finished: [], finishedTotal: 0, failedTotal: 0 }
      : null
  const own = botOwnChatTree({
    chats: header ? [header, ...result.chats] : result.chats,
    workspaceChats: {}
  })
  const homeId = answerHome?.chatId ?? header?.chatId ?? null
  const byId = new Map(own.chats.map((chat) => [chat.chatId, chat]))
  // Each listed chat once, in the answer's order; a room's worker hits join Home's.
  const hits = new Map<string, ReadonlySet<string> | null>()
  for (const match of result.matches) {
    const room = homeId !== null && isBotGroupMemberSession(match.chatId)
    if (room && !match.workerKeys) {
      continue
    }
    const chatId = room ? homeId : match.chatId
    const keys = match.workerKeys ? new Set(match.workerKeys) : null
    const before = hits.get(chatId)
    hits.set(
      chatId,
      before === undefined
        ? keys
        : before === null || keys === null
          ? null
          : new Set([...before, ...keys])
    )
  }
  return [...hits].flatMap(([chatId, matches]) => {
    const chat = byId.get(chatId)
    return chat ? [{ chat, matches }] : []
  })
}

/** What a search shows: the host's answer, or (from a host without the search) the chats read here. */
export type BotChatSearchState = {
  hits: BotChatSearchHit[]
  more: number
  pending: boolean
  /** The host couldn't be asked or failed to answer. */
  failed: boolean
}

/** The Chats list as shown: 8 chats, then 8 more per step; a search shows its own hits. */
export function botChatListView(
  chats: readonly BotChatTreeChat[],
  {
    steps,
    query,
    search,
    first = CHAT_TREE_CAPS.step
  }: {
    steps: number
    query: string
    search: BotChatSearchState | null
    /** Chats shown before the first step; each step adds `CHAT_TREE_CAPS.step`. */
    first?: number
  }
): BotChatListView {
  const searching = query.trim() !== ''
  const found = searching
    ? (search?.hits ?? [])
    : chats.slice(0, first + CHAT_TREE_CAPS.step * steps).map((chat) => ({ chat, matches: null }))
  return {
    found,
    older: searching ? 0 : chats.length - found.length,
    onlyHome: chats.length === 1 && chats[0].origin === 'home' && chats[0].finishedTotal === 0,
    noMatch:
      searching && search !== null && !search.pending && !search.failed && found.length === 0,
    searchFailed: searching && search?.failed === true,
    moreMatches: searching ? (search?.more ?? 0) : 0
  }
}

/** The Chats tab's one list: chats with something going (replying, waiting on the owner, or a worker
 *  running) first, then the rest; newest first in each. */
export function orderChatsTab(chats: readonly BotChatTreeChat[]): BotChatTreeChat[] {
  return [...chats].sort(
    (a, b) => Number(chatIsGoing(b)) - Number(chatIsGoing(a)) || b.lastActiveAt - a.lastActiveAt
  )
}

/** An unfolded chat's workers in the Chats tab before Show more. */
export const CHATS_TAB_FIRST_WORKERS = 5

/** An unfolded chat's workers in the Chats tab: live ones (waiting on the owner first), then finished,
 *  `limit` at most. `read` says the host must be asked for more finished ones to fill the limit. */
export function chatsTabWorkers(
  chat: BotChatTreeChat,
  limit: number
): { workers: BotChatTreeWorker[]; more: number; read: boolean } {
  const running = [...chat.running].sort(
    (a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you')
  )
  const workers = [...running, ...chat.finished].slice(0, limit)
  const total = chat.runningTotal + chat.finishedTotal
  return {
    workers,
    more: Math.max(0, total - workers.length),
    read: workers.length < Math.min(limit, total) && chat.finished.length < chat.finishedTotal
  }
}

/** Where a chat came from, for its line: the thread's place or automation's name, else the service. */
export function botChatPlace(chat: BotChatTreeChat): string | null {
  // A run is titled by its automation already.
  if (chat.originLabel && chat.originLabel !== chat.title) {
    return chat.originLabel
  }
  return chat.origin === 'slack' || chat.origin === 'linear' || chat.origin === 'github'
    ? CONNECTOR_SOURCE_NAMES[chat.origin]
    : null
}
