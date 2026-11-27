// A bot chat, worker or run stopped on its agent's usage limit, as its host's status feed says it.
import type { AgentSessionStatusSummary } from '../agent-session/agent-session-wire'
import type { AgentSessionStatusSnapshot } from '../agent-session/view/agent-session-status-snapshot-fold'
import { formatUsageLimitResetClock } from '../agent-session/failures/agent-session-usage-limit'
import type { BotChatTranslate as Translate } from './bot-chat-tree'
import type { BotRowLine } from './bot-row-line'

/** `at`: when Orca continues it (`auto`), else when the limit resets. */
export type UsageLimitStop = { at: number; auto: boolean }

/** How long a stop Orca continues keeps showing past its time, while its send waits on a fresh
 *  usage reading or a retry; a chat it has continued drops its cut sooner. */
export const AUTO_CONTINUE_GRACE_MS = 10 * 60_000

/** A session's stop while its limit still holds; a reset already past is no stop. */
export function usageLimitStopOf(
  summary: Pick<AgentSessionStatusSummary, 'usageLimitContinue'> | undefined,
  now: number
): UsageLimitStop | null {
  const cut = summary?.usageLimitContinue
  if (!cut) {
    return null
  }
  const stop =
    cut.state === 'scheduled'
      ? { at: cut.continueAt ?? cut.resetsAt, auto: true }
      : { at: cut.resetsAt, auto: false }
  return stop.at + (stop.auto ? AUTO_CONTINUE_GRACE_MS : 0) > now ? stop : null
}

/** A stopped session of the bot's, with the name its row would say. */
export type NamedUsageLimitStop = UsageLimitStop & {
  sessionId: string
  name: string | null
  agent: AgentSessionStatusSummary['agent']
}

/** Every stopped session the host lists, with its workspace, soonest first. */
export function usageLimitStops(
  sessions: AgentSessionStatusSnapshot,
  now: number
): (NamedUsageLimitStop & { workspaceId: string })[] {
  const stops: (NamedUsageLimitStop & { workspaceId: string })[] = []
  for (const summary of sessions.values()) {
    const stop = usageLimitStopOf(summary, now)
    if (stop) {
      stops.push({
        ...stop,
        sessionId: summary.sessionId,
        workspaceId: summary.workspaceId,
        name: summary.conversationName ?? null,
        agent: summary.agent
      })
    }
  }
  return stops.sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId))
}

/** "Continues at 9:50 PM", or "Hit limit · resets 9:50 PM" when Orca won't continue it. */
export function usageLimitStopText(t: Translate, stop: UsageLimitStop): string {
  const time = formatUsageLimitResetClock(stop.at)
  return stop.auto
    ? t('bots.usageLimit.continuesAt', 'Continues at {{time}}', { time })
    : t('bots.usageLimit.hitLimit', 'Hit limit · resets {{time}}', { time })
}

/** A chat, worker or run stopped on its usage limit, said while nothing of the bot's works or
 *  waits on the owner; those still speak first. */
export type BotRowLimit = { place: string | null; stop: NamedUsageLimitStop }

/** Lines about live work or the owner, which a stop never covers; a past activity or a wait can be. */
const LIVE_LINES: ReadonlySet<BotRowLine['kind']> = new Set([
  'paused',
  'reading',
  'replying',
  'needYouElsewhere',
  'workingElsewhere'
])

/** The row's stop in place of its line, named by where it stopped; none while the bot is busy. */
export function botRowLimit(
  stop: NamedUsageLimitStop | null | undefined,
  line: BotRowLine | null,
  busy: boolean,
  chatSessionId: string | null | undefined,
  t: Translate
): BotRowLimit | null {
  if (!stop || busy || (line && LIVE_LINES.has(line.kind))) {
    return null
  }
  return {
    place: stop.sessionId === chatSessionId ? t('bots.chats.home', 'Home Chat') : stop.name,
    stop
  }
}
