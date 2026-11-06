import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'

/** What one agent line means for the Experimental 2.0 card, in slot priority order. */
export type SlotLineKind = 'needs' | 'failed' | 'unread' | 'working' | 'seen' | 'idle'

/** `monitoring`: working, but watching rather than taking turns; drawn with its own glyph. */
export type SlotLineSignal = { kind: SlotLineKind; at: number | null; monitoring?: boolean }

/** One right-hand slot: the first exception that applies, otherwise a time, or quiet. */
export type SlotSignal =
  | { kind: 'needs'; count: number }
  | { kind: 'failed' }
  | { kind: 'unread'; at: number | null; manual: boolean }
  | { kind: 'working'; at: number | null; monitoring?: boolean }
  | { kind: 'offline' }
  | { kind: 'time'; at: number | null }
  | { kind: 'quiet' }

const LINE_KIND_RANK: Record<SlotLineKind, number> = {
  needs: 0,
  failed: 1,
  unread: 2,
  working: 3,
  seen: 4,
  idle: 5
}

export function classifySlotLine(args: {
  dotState: AgentDotState
  needsAttention: boolean
  unreadCompletion: boolean
}): SlotLineKind {
  const { dotState } = args
  if (
    args.needsAttention ||
    dotState === 'waiting' ||
    dotState === 'blocked' ||
    dotState === 'permission'
  ) {
    return 'needs'
  }
  if (dotState === 'failed') {
    return 'failed'
  }
  if (dotState === 'working' || dotState === 'monitoring') {
    return 'working'
  }
  if (dotState === 'done' || dotState === 'interrupted' || dotState === 'unconfirmed') {
    return args.unreadCompletion ? 'unread' : 'seen'
  }
  return 'idle'
}

/** Working shows how long; everything else shows when it last changed. */
export function slotLineAt(
  agent: Pick<DashboardAgentRow, 'rowSource' | 'state' | 'entry' | 'childRow' | 'startedAt'>,
  kind: SlotLineKind
): number | null {
  const stateStartedAt = agent.entry.stateStartedAt > 0 ? agent.entry.stateStartedAt : null
  if (kind === 'working' || kind === 'needs') {
    return stateStartedAt ?? (agent.startedAt > 0 ? agent.startedAt : null)
  }
  return lastEnteredDoneAt(agent) ?? stateStartedAt
}

export function compareSlotLines(a: SlotLineSignal, b: SlotLineSignal): number {
  return LINE_KIND_RANK[a.kind] - LINE_KIND_RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0)
}

function latest(lines: readonly SlotLineSignal[]): number | null {
  let at: number | null = null
  for (const line of lines) {
    if (line.at !== null && (at === null || line.at > at)) {
      at = line.at
    }
  }
  return at
}

/** The exception a set of lines reports, or null when every line is quiet. */
export function slotExceptionFor(lines: readonly SlotLineSignal[]): SlotSignal | null {
  const needs = lines.filter((line) => line.kind === 'needs').length
  if (needs > 0) {
    return { kind: 'needs', count: needs }
  }
  if (lines.some((line) => line.kind === 'failed')) {
    return { kind: 'failed' }
  }
  const unread = lines.filter((line) => line.kind === 'unread')
  if (unread.length > 0) {
    return { kind: 'unread', at: latest(unread), manual: false }
  }
  const working = lines.filter((line) => line.kind === 'working')
  if (working.length > 0) {
    return {
      kind: 'working',
      at: latest(working),
      monitoring: working.every((line) => line.monitoring === true)
    }
  }
  return null
}

export function slotForLine(line: SlotLineSignal): SlotSignal {
  return slotExceptionFor([line]) ?? { kind: 'time', at: line.at }
}

const SLOT_EXCEPTION_RANK: Partial<Record<SlotSignal['kind'], number>> = {
  needs: 0,
  failed: 1,
  unread: 2,
  working: 3
}

export function mergeSlotExceptions(a: SlotSignal | null, b: SlotSignal | null): SlotSignal | null {
  if (!a || !b) {
    return a ?? b
  }
  if (a.kind === 'needs' && b.kind === 'needs') {
    return { kind: 'needs', count: a.count + b.count }
  }
  if (
    (a.kind === 'unread' && b.kind === 'unread') ||
    (a.kind === 'working' && b.kind === 'working')
  ) {
    return (b.at ?? 0) > (a.at ?? 0) ? b : a
  }
  return (SLOT_EXCEPTION_RANK[a.kind] ?? 9) <= (SLOT_EXCEPTION_RANK[b.kind] ?? 9) ? a : b
}

/**
 * The title row stays quiet while its agent lines are on screen; it speaks only for
 * sources the user can't see: hidden agents, collapsed children, or the workspace's own unread mark.
 */
export function titleRowSlot(args: {
  offline: boolean
  hiddenLines: readonly SlotLineSignal[]
  collapsedLineage: SlotSignal | null
  /** Set while the workspace is unread and no visible agent line already shows it; manual = the user marked it. */
  workspaceUnread: { manual: boolean } | null
  ownLinesShown: boolean
  lastActivityAt: number | null
  lineageLatestAt?: number | null
}): SlotSignal {
  if (args.offline) {
    return { kind: 'offline' }
  }
  const workspaceSignal: SlotSignal | null = args.workspaceUnread
    ? { kind: 'unread', at: args.lastActivityAt, manual: args.workspaceUnread.manual }
    : null
  const exception = mergeSlotExceptions(
    mergeSlotExceptions(slotExceptionFor(args.hiddenLines), args.collapsedLineage),
    workspaceSignal
  )
  if (exception) {
    return exception
  }
  if (args.ownLinesShown) {
    return { kind: 'quiet' }
  }
  const ownAt = latest(args.hiddenLines) ?? args.lastActivityAt
  const lineageAt = args.lineageLatestAt ?? null
  return {
    kind: 'time',
    at: ownAt === null || (lineageAt !== null && lineageAt > ownAt) ? lineageAt : ownAt
  }
}
