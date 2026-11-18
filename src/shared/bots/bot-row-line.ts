// A bot row's second line: what needs the owner, else what the bot is doing or did last across its
// own chats and threads, else what it waits for; a wait is passive and can last days, so it never hides activity.
// The desktop sidebar and the phone's Bots list both pick it here, each reading its own agent rows.
import { structuredAgentSessionStatusPaneKey } from '../agent-session/view/structured-agent-session-tab'
import {
  CONNECTOR_SOURCE_NAMES,
  type ConnectorSource,
  type ExternalConversationLink
} from '../connectors/external-conversation-link'
import type { BotListWait } from './bot-list-waits'
import { newestBotActivity } from './bot-row-activity'
import type { BotWorkspaceLiveCounts } from './bot-sidebar-workspaces'

/** Where a turn is: a thread's service and place as people name it, or (no service) a side chat's title. */
export type BotRowPlace = { source: ConnectorSource | null; label: string }

export type BotRowLine =
  | { kind: 'paused' }
  /** Its Chat's or a thread's agent is starting, before any turn is attached. */
  | { kind: 'reading' }
  /** A turn is under way and the bot has posted no status of its own yet; never the agent's name. */
  | { kind: 'replying'; place: BotRowPlace | null }
  /** `place` names the thread when the thread began the latest turn, or the side chat; null in Home Chat. */
  | { kind: 'activity'; place: BotRowPlace | null; text: string; at: number | null }
  /** Its chats and threads are quiet; this many of its runs and workers wait on the owner. */
  | { kind: 'needYouElsewhere'; count: number }
  /** Its chats and threads are quiet; this many of its runs and workers are working. */
  | { kind: 'workingElsewhere'; count: number }
  /** Nothing else to say; with several waits only their count, `more` past the first. */
  | { kind: 'wait'; wait: BotListWait; more: number }

/** What the line reads of a thread's link: which pane is the thread's, and where it is. */
export type BotRowLineLink = Pick<
  ExternalConversationLink,
  'source' | 'sessionId' | 'paneKey' | 'title' | 'place' | 'lastTurn'
>

/** One of the bot's own side chats, as its host classed it (`bots.chats.own`): its pane and title. */
export type BotRowLineChat = { paneKey: string; title: string }

/** How an app reads its own agent rows for the line. */
export type BotRowLineReader<R> = {
  paneKey: (row: R) => string
  /** A provider subagent inside a pane, which never speaks for the bot. */
  subagent: (row: R) => boolean
  /** Working, or stopped on a question for the owner. */
  live: (row: R) => boolean
  /** Stopped on a question or approval for the owner. */
  needsYou: (row: R) => boolean
  updatedAt: (row: R) => number
  /** What the agent itself reported, or null when it has said nothing yet. */
  status: (row: R, now: number) => string | null
  at: (row: R) => number | null
}

export type BotRowLineInput<R> = {
  paused: boolean
  /** Its Chat's and threads' sessions whose agent is starting. */
  startingSessionIds?: ReadonlySet<string>
  /** Agent rows of its home: its own chats and threads speak for it; the rest (automation runs,
   *  Look around) only count as needing the owner or working. */
  rows: readonly R[]
  chatSessionId: string | null
  links: readonly BotRowLineLink[]
  /** Its own side chats, once read; until then, and from an older host, they count as the rest do. */
  chats?: readonly BotRowLineChat[]
  waits: readonly BotListWait[]
  /** Its workers' workspaces, live; older hosts and surfaces without them send none. */
  workers?: Pick<BotWorkspaceLiveCounts, 'permission' | 'working'>
  /** The bot's Needs you count (`botNeedsYouCount`), where it is read: the count the line falls back
   *  to, in place of its own rows', so it says what the Items tab badge says. */
  needsYou?: number
  /** Without `needsYou`: the bot's Needs you items its host's list counted, added to its own rows'. */
  itemsNeedingYou?: number
  now: number
}

// A Linear thread's title starts with its issue key ("ENG-42 · …"), for links from before places were kept.
const LINEAR_KEY = /^[A-Z][A-Z0-9]*-\d+\b/

/** Its kept place, else what an older link can say: a Linear key, or the service's name. */
function threadPlace(link: BotRowLineLink): BotRowPlace {
  const key = link.source === 'linear' ? LINEAR_KEY.exec(link.title ?? '')?.[0] : undefined
  return { source: link.source, label: link.place ?? key ?? CONNECTOR_SOURCE_NAMES[link.source] }
}

/** Paused; else what needs the owner, its chats' or threads' first, then the rest's; else what is
 *  working, the same way; else its newest activity; a wait only when none says anything. */
export function selectBotRowLine<R>(
  input: BotRowLineInput<R>,
  read: BotRowLineReader<R>
): BotRowLine | null {
  if (input.paused) {
    return { kind: 'paused' }
  }
  const chatPaneKey = input.chatSessionId
    ? structuredAgentSessionStatusPaneKey(input.chatSessionId)
    : null
  const linkByPaneKey = new Map(input.links.map((link) => [link.paneKey, link]))
  const sideChatByPaneKey = new Map((input.chats ?? []).map((chat) => [chat.paneKey, chat]))
  const candidates: { row: R; place: BotRowPlace | null }[] = []
  const others: R[] = []
  for (const row of input.rows) {
    if (read.subagent(row)) {
      continue
    }
    const paneKey = read.paneKey(row)
    const link = linkByPaneKey.get(paneKey)
    const sideChat = sideChatByPaneKey.get(paneKey)
    if (paneKey === chatPaneKey) {
      // First, so Home Chat wins a tie.
      candidates.unshift({ row, place: null })
    } else if (link) {
      // A turn begun in Orca (typed, another chat's mail, an automation) is not the thread's, as Slack agrees.
      candidates.push({ row, place: link.lastTurn === 'conversation' ? threadPlace(link) : null })
    } else if (sideChat) {
      candidates.push({ row, place: { source: null, label: sideChat.title } })
    } else {
      others.push(row)
    }
  }
  const workers = input.workers
  const needYouElsewhere =
    input.needsYou ??
    others.filter(read.needsYou).length + (workers?.permission ?? 0) + (input.itemsNeedingYou ?? 0)
  const workingElsewhere =
    others.filter((row) => read.live(row) && !read.needsYou(row)).length + (workers?.working ?? 0)
  const newestOf = (only: (row: R) => boolean) =>
    newestBotActivity(
      candidates.filter(({ row }) => only(row)),
      ({ row }) => read.updatedAt(row)
    )
  const say = (pick: { row: R; place: BotRowPlace | null }): BotRowLine => {
    const text = read.status(pick.row, input.now)
    return text
      ? { kind: 'activity', place: pick.place, text, at: read.at(pick.row) }
      : { kind: 'replying', place: pick.place }
  }
  const asking = newestOf(read.needsYou)
  if (asking) {
    return say(asking)
  }
  if (needYouElsewhere > 0) {
    return { kind: 'needYouElsewhere', count: needYouElsewhere }
  }
  const starting = input.startingSessionIds
  if (
    starting?.size &&
    ((input.chatSessionId !== null && starting.has(input.chatSessionId)) ||
      input.links.some((link) => starting.has(link.sessionId)))
  ) {
    return { kind: 'reading' }
  }
  const working = newestOf(read.live)
  if (working) {
    return say(working)
  }
  if (workingElsewhere > 0) {
    return { kind: 'workingElsewhere', count: workingElsewhere }
  }
  const said = newestOf((row) => read.status(row, input.now) !== null)
  if (said) {
    return say(said)
  }
  // A deadline that has passed is the wait's end, not a wait.
  const [wait, ...moreWaits] = input.waits.filter((w) => w.by === undefined || w.by > input.now)
  return wait ? { kind: 'wait', wait, more: moreWaits.length } : null
}

const DAY_MS = 24 * 60 * 60 * 1000
const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

/** How a wait's deadline reads: "2:14 AM" today, "Fri 5 PM" within the week, "Nov 14, 5 PM"
 *  further; minutes only off the hour. Each app formats with its own locale. */
export function botWaitTimeFormat(at: number, now: number): Intl.DateTimeFormatOptions {
  const time = new Date(at).getMinutes() === 0 ? { hour: 'numeric' as const } : CLOCK
  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return time
  }
  return Math.abs(at - now) < 6 * DAY_MS
    ? { weekday: 'short', ...time }
    : { month: 'short', day: 'numeric', ...time }
}

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

// Chat-like places are "in" a channel; issues and pull requests are "on" one.
export function botRowReplyingAt(t: Translate, place: BotRowPlace, label = place.label): string {
  return place.source === null || place.source === 'slack' || place.source === 'discord'
    ? t('bots.row.replyingIn', 'Replying in {{place}}', { place: label })
    : t('bots.row.replyingOn', 'Replying on {{place}}', { place: label })
}

/** The line's words, the same on both apps; each passes its own translate and wait-time format. */
export function botRowLineText(
  line: BotRowLine,
  t: Translate,
  waitTime: (by: number) => string
): string {
  switch (line.kind) {
    case 'paused':
      return t('bots.row.paused', 'Paused')
    case 'reading':
      return t('bots.row.reading', 'Reading your message')
    case 'replying':
      return line.place ? botRowReplyingAt(t, line.place) : t('bots.row.replying', 'Replying')
    case 'activity':
      return line.place ? `${line.place.label} · ${line.text}` : line.text
    case 'needYouElsewhere':
      return t('bots.panel.needYou', '{{count}} need you', {
        count: line.count,
        defaultValue_one: '{{count}} needs you'
      })
    case 'workingElsewhere':
      return t('bots.panel.working', '{{count}} working', { count: line.count })
    case 'wait': {
      if (line.more > 0) {
        return t('bots.row.waitingCount', 'Waiting on {{count}} events', { count: line.more + 1 })
      }
      const { label, by } = line.wait
      return by === undefined
        ? t('bots.row.waitingFor', 'Waiting for {{label}}', { label })
        : t('bots.row.waitingForUntil', 'Waiting for {{label}} · until {{time}}', {
            label,
            time: waitTime(by)
          })
    }
  }
}
