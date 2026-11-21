// The Automations card: its rows failed first, then running, then soonest next; paused ones last.
import { useState } from 'react'
import { getToneForAutomationRunStatus } from '../../../../shared/automation-last-run'
import { hasAutomationSchedule } from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { botTidyUp, TIDY_UP_HOURS } from '../../../../shared/bots/bot-tidy-up'
import { botUpcomingRows, type BotUpcomingRow } from './bot-upcoming-rows'

/** Automations and waits shown before "All N automations"; Look around and Tidy memory always show. */
export const AUTOMATION_CARD_CAP = 5

/** What a row says of its newest run; null says nothing. */
export type BotRunMark = { kind: 'running' } | { kind: 'failed' } | { kind: 'ran'; at: number }

export type BotAutomationCardRow = BotUpcomingRow & {
  failed: boolean
  running: boolean
  /** Its next run, only while still ahead (a past one is never "next"); set whether on or off, so a
   *  flipped switch alone never re-ranks the row. */
  nextAt: number | null
  /** Next is an exact time, not a window (Tidy memory runs some time overnight). */
  exactNext: boolean
  mark: BotRunMark | null
  /** Its newest run as the switch can't change it (`failed` clears while paused): the card re-ranks
   *  when it changes, never on a flipped switch alone. */
  runFacts: string
}

type CardActivity = Pick<BotActivity, 'automations' | 'waits' | 'upNext' | 'inProgress'>

const ahead = (at: number | undefined, now: number): number | null =>
  at !== undefined && at > now ? at : null

function nextTidyAt(now: number): number {
  const at = new Date(now)
  at.setHours(TIDY_UP_HOURS.from, 0, 0, 0)
  if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1)
  }
  return at.getTime()
}

function automationFacts(
  row: BotAutomationRow,
  running: boolean,
  now: number
): Pick<BotAutomationCardRow, 'failed' | 'running' | 'nextAt' | 'exactNext' | 'mark' | 'runFacts'> {
  const { automation } = row
  const failed = row.failing
  const tone = row.lastRun ? getToneForAutomationRunStatus(row.lastRun.status) : null
  const isRunning = !failed && (running || tone === 'running')
  const mark: BotRunMark | null = failed
    ? { kind: 'failed' }
    : isRunning
      ? { kind: 'running' }
      : automation.enabled && row.lastRun && tone === 'succeeded'
        ? { kind: 'ran', at: row.lastRun.at }
        : null
  return {
    failed,
    running: isRunning,
    nextAt: hasAutomationSchedule(automation) ? ahead(automation.nextRunAt, now) : null,
    exactNext: true,
    mark,
    runFacts: row.lastRun ? `${row.lastRun.status}@${row.lastRun.at}` : ''
  }
}

/** The card's rows in the fixed order `botUpcomingRows` gives, with what the card sorts and says by. */
export function botAutomationCardRows(
  bot: Bot,
  activity: CardActivity,
  now: number
): BotAutomationCardRow[] {
  const runningIds = new Set(
    activity.inProgress.flatMap((row) => (row.kind === 'run' ? [row.automationId] : []))
  )
  return botUpcomingRows(bot, activity).map((row): BotAutomationCardRow => {
    switch (row.kind) {
      case 'tidy-up':
        return {
          ...row,
          failed: false,
          running: false,
          nextAt: botTidyUp(bot).every === 'night' ? nextTidyAt(now) : null,
          exactNext: false,
          mark: null,
          runFacts: ''
        }
      case 'look-around': {
        const state = activity.upNext?.state
        const running = state?.running === true
        const failed = row.on && !running && Boolean(state?.error)
        return {
          ...row,
          failed,
          running,
          nextAt: running ? null : state?.dueNow ? now : ahead(state?.nextAt, now),
          exactNext: true,
          mark: running
            ? { kind: 'running' }
            : failed
              ? { kind: 'failed' }
              : row.on && state?.lastLookedAt
                ? { kind: 'ran', at: state.lastLookedAt }
                : null,
          runFacts: `${Boolean(state?.error)}@${state?.lastLookedAt ?? ''}`
        }
      }
      case 'automation':
        return {
          ...row,
          ...automationFacts(row.row, runningIds.has(row.row.automation.id), now)
        }
      case 'wait':
        return {
          ...row,
          failed: false,
          running: false,
          nextAt: ahead(row.row.automation.once?.by, now),
          exactNext: true,
          mark: null,
          runFacts: ''
        }
    }
  })
}

function rank(row: BotAutomationCardRow): number {
  if (row.failed) {
    return 0
  }
  if (row.running) {
    return 1
  }
  if (!row.on) {
    return 4
  }
  return row.nextAt === null ? 3 : 2
}

/** Failed, running, then soonest next; rows with no next keep their fixed order, paused ones last. */
export function rankAutomationCardRows(
  rows: readonly BotAutomationCardRow[]
): BotAutomationCardRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        rank(a.row) - rank(b.row) ||
        (a.row.nextAt ?? Infinity) - (b.row.nextAt ?? Infinity) ||
        a.index - b.index
    )
    .map(({ row }) => row)
}

/** Built-ins always show, outside the cap: the Automations page that "All N" opens doesn't list them. */
export function botAutomationCardView(ordered: readonly BotAutomationCardRow[]): {
  shown: BotAutomationCardRow[]
  /** What the Automations page lists: automations and waits. */
  listed: number
  listedPaused: number
} {
  const listed = ordered.filter((row) => row.kind === 'automation' || row.kind === 'wait')
  const kept = new Set(listed.slice(0, AUTOMATION_CARD_CAP).map((row) => row.key))
  return {
    shown: ordered.filter(
      (row) => (row.kind !== 'automation' && row.kind !== 'wait') || kept.has(row.key)
    ),
    listed: listed.length,
    listedPaused: listed.filter((row) => !row.on).length
  }
}

/** The soonest exact next run among rows that are on, not failing and not running, for the header's Idle line. */
export function botNextRun(rows: readonly BotAutomationCardRow[]): BotAutomationCardRow | null {
  return (
    rankAutomationCardRows(rows).find(
      (row) => row.on && !row.failed && !row.running && row.exactNext && row.nextAt !== null
    ) ?? null
  )
}

/** The first row that says Running, so the header says so too instead of Idle. */
export function botRunningRow(rows: readonly BotAutomationCardRow[]): BotAutomationCardRow | null {
  return rankAutomationCardRows(rows).find((row) => row.running) ?? null
}

type OrderFacts = { runFacts: string; running: boolean; nextAt: number | null }

/**
 * The card's order, re-ranked only when rows come or go or their run facts change: a switch flipped
 * here, and the host's refresh after it, leave its row in place until the panel next opens.
 */
export function useAutomationCardOrder(
  rows: readonly BotAutomationCardRow[]
): BotAutomationCardRow[] {
  const [order, setOrder] = useState<{
    keys: string[]
    /** What each row's ranking last read. */
    facts: ReadonlyMap<string, OrderFacts>
  } | null>(null)
  const facts = new Map(
    rows.map((row): [string, OrderFacts] => [
      row.key,
      {
        runFacts: row.runFacts,
        running: row.running,
        nextAt: row.nextAt
      }
    ])
  )
  const rerank =
    !order ||
    order.facts.size !== rows.length ||
    rows.some((row) => {
      const before = order.facts.get(row.key)
      return (
        !before ||
        before.running !== row.running ||
        before.nextAt !== row.nextAt ||
        before.runFacts !== row.runFacts
      )
    })
  let keys = order?.keys ?? []
  if (rerank) {
    keys = rankAutomationCardRows(rows).map((row) => row.key)
    setOrder({ keys, facts })
  }
  const byKey = new Map(rows.map((row) => [row.key, row]))
  return keys.flatMap((key) => {
    const row = byKey.get(key)
    return row ? [row] : []
  })
}
