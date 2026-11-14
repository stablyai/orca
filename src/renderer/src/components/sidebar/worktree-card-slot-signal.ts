import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { lastEnteredDoneAt } from '@/components/dashboard/rows/agent-finished-timestamp'

/** What one agent line means for the experimental card, in slot priority order. */
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

function latest(lines: readonly SlotLineSignal[]): number | null {
  let at: number | null = null
  for (const line of lines) {
    if (line.at !== null && (at === null || line.at > at)) {
      at = line.at
    }
  }
  return at
}

function maxAt(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b
  }
  return b === null || a >= b ? a : b
}

export type SlotException = Extract<
  SlotSignal,
  { kind: 'needs' } | { kind: 'failed' } | { kind: 'unread' } | { kind: 'working' }
>

const SLOT_EXCEPTION_ORDER: readonly SlotException['kind'][] = [
  'needs',
  'failed',
  'unread',
  'working'
]

/** Every exception a set of lines reports, one per kind, most urgent first. */
export function slotExceptionsFor(lines: readonly SlotLineSignal[]): SlotException[] {
  const exceptions: SlotException[] = []
  const needs = lines.filter((line) => line.kind === 'needs').length
  if (needs > 0) {
    exceptions.push({ kind: 'needs', count: needs })
  }
  if (lines.some((line) => line.kind === 'failed')) {
    exceptions.push({ kind: 'failed' })
  }
  const unread = lines.filter((line) => line.kind === 'unread')
  if (unread.length > 0) {
    exceptions.push({ kind: 'unread', at: latest(unread), manual: false })
  }
  const working = lines.filter((line) => line.kind === 'working')
  if (working.length > 0) {
    exceptions.push({
      kind: 'working',
      at: latest(working),
      monitoring: working.every((line) => line.monitoring === true)
    })
  }
  return exceptions
}

function mergeSameKind(a: SlotException, b: SlotException): SlotException {
  if (a.kind === 'needs' && b.kind === 'needs') {
    return { kind: 'needs', count: a.count + b.count }
  }
  if (a.kind === 'working' && b.kind === 'working') {
    return {
      kind: 'working',
      at: maxAt(a.at, b.at),
      monitoring: a.monitoring === true && b.monitoring === true
    }
  }
  if (a.kind === 'unread' && b.kind === 'unread') {
    return { kind: 'unread', at: maxAt(a.at, b.at), manual: a.manual || b.manual }
  }
  return a
}

/** One exception per kind across several sources, most urgent first. */
export function mergeSlotExceptions(
  ...lists: readonly (readonly SlotException[])[]
): SlotException[] {
  const byKind = new Map<SlotException['kind'], SlotException>()
  for (const exception of lists.flat()) {
    const previous = byKind.get(exception.kind)
    byKind.set(exception.kind, previous ? mergeSameKind(previous, exception) : exception)
  }
  return SLOT_EXCEPTION_ORDER.flatMap((kind) => byKind.get(kind) ?? [])
}

/** The title row: offline, or every exception it speaks for followed by a time. */
export type TitleRowSlot =
  | { kind: 'offline' }
  | { kind: 'status'; exceptions: SlotException[]; at: number | null }

/**
 * The title row speaks for exceptions the user can't see (hidden agents, collapsed children,
 * the workspace's own unread mark), and always shows the time so expanding doesn't jump.
 */
export function titleRowSlot(args: {
  offline: boolean
  lines: readonly SlotLineSignal[]
  collapsedLineage: readonly SlotException[]
  /** Set while the workspace is unread and no visible agent line already shows it; manual = the user marked it. */
  workspaceUnread: { manual: boolean } | null
  ownLinesShown: boolean
  lastActivityAt: number | null
  lineageLatestAt?: number | null
}): TitleRowSlot {
  if (args.offline) {
    return { kind: 'offline' }
  }
  const workspaceSignal: SlotException[] = args.workspaceUnread
    ? [{ kind: 'unread', at: args.lastActivityAt, manual: args.workspaceUnread.manual }]
    : []
  const exceptions = mergeSlotExceptions(
    slotExceptionsFor(args.ownLinesShown ? [] : args.lines),
    args.collapsedLineage,
    workspaceSignal
  )
  // Unread and working keep their own time (when it landed, how long it has run).
  for (const exception of exceptions) {
    if ((exception.kind === 'unread' || exception.kind === 'working') && exception.at !== null) {
      return { kind: 'status', exceptions, at: exception.at }
    }
  }
  // Quiet fallback: the newest of agent lines, workspace activity, and lineage, so a card
  // never shows an older time than its own workspace (or its rollup parent) reports.
  return {
    kind: 'status',
    exceptions,
    at: maxAt(maxAt(latest(args.lines), args.lastActivityAt), args.lineageLatestAt ?? null)
  }
}

/**
 * Whether the card shows the unread dot: any of its agent lines (shown or hidden), the workspace's
 * own unread, or a collapsed child's. Read from the sources rather than the title slot, because an
 * offline slot carries no exceptions and a disconnected parent must still surface an unread child.
 */
export function titleRowUnread(args: {
  lines: readonly SlotLineSignal[]
  collapsedLineage: readonly SlotException[]
  workspaceUnread: boolean
}): boolean {
  return (
    args.workspaceUnread ||
    args.lines.some((line) => line.kind === 'unread') ||
    args.collapsedLineage.some((exception) => exception.kind === 'unread')
  )
}
