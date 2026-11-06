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

/** The most urgent exception a set of lines reports, or null when every line is quiet. */
export function slotExceptionFor(lines: readonly SlotLineSignal[]): SlotSignal | null {
  return slotExceptionsFor(lines)[0] ?? null
}

export function slotForLine(line: SlotLineSignal): SlotSignal {
  return slotExceptionFor([line]) ?? { kind: 'time', at: line.at }
}

function mergeSameKind(a: SlotException, b: SlotException): SlotException {
  if (a.kind === 'needs' && b.kind === 'needs') {
    return { kind: 'needs', count: a.count + b.count }
  }
  if (
    (a.kind === 'unread' && b.kind === 'unread') ||
    (a.kind === 'working' && b.kind === 'working')
  ) {
    return (b.at ?? 0) > (a.at ?? 0) ? b : a
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
  const ownAt = latest(args.lines) ?? args.lastActivityAt
  const lineageAt = args.lineageLatestAt ?? null
  return {
    kind: 'status',
    exceptions,
    at: ownAt === null || (lineageAt !== null && lineageAt > ownAt) ? lineageAt : ownAt
  }
}
