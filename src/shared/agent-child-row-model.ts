/**
 * One row model for every surface that lists child work (the sidebar's child rows and the chat
 * strip), with one builder per shape a host may publish. All three name a row with one label rule
 * (`usableAgentChildLabel`) and decide what it says with one detail rule (`agentChildRowDetail`):
 *  - `buildAgentChildRowModels`: the host's child views (`children`), the source of record.
 *  - `buildLegacyAgentChildRowModels`: the `subagents` snapshot.
 *  - `buildLegacyTaskRowModels`: the session feed's `tasks` / `settledTasks` roster.
 *
 * The two legacy builders exist only for hosts that publish no views, and each is deleted, not
 * migrated, when its last publisher is gone: the snapshot builder once CLI panes publish
 * `children` and no supported paired host predates that; the roster builder once no supported
 * paired host predates child views on the session feed.
 */
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import type { AgentChildWorkKind } from './agent-status-child-work'
import { resolveAgentChildWorkFreshness } from './agent-status-child-work-freshness'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState,
  type AgentChildDisplayState
} from './agent-status-child-work-display'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import {
  agentStatusAuthorityObservedAt,
  agentStatusEvidenceObservedAt
} from './agent-status-freshness'
import type { AgentStatusEntry, AgentSubagentSnapshot } from './agent-status-types'

/** What a child row says beside its name. Surfaces format it; they never decide it. */
export type AgentChildRowDetail =
  /** The tool the child is running now, as `tool: input` — the line a CLI agent row shows. */
  | { kind: 'operation'; toolName: string; input?: string }
  /** Its own work is over and only work it owns still runs; the tool line is stale. */
  | { kind: 'monitoring' }
  | { kind: 'message'; text: string }
  /** Settled, and the lane cannot say how. */
  | { kind: 'ended' }
  /** How long since the last evidence for this child (see `recencyAt`). */
  | { kind: 'no-update' }
  /** The child's role, when nothing more specific is known. */
  | { kind: 'role'; agentType: string }
  /** A host that publishes only a run state: that state's reason word. */
  | { kind: 'reason'; state: 'waiting' | 'blocked' | 'unverifiable' }

/** One child row, for every surface that lists child work (sidebar and chat strip). */
export type AgentChildRowModel = {
  /** Row identity: the host's child id, or the provider id an old host names it by. */
  id: string
  /** The id a targeted stop names; absent when the host holds none. */
  providerId?: string
  kind: AgentChildWorkKind
  displayState: AgentChildDisplayState
  /** '' when the child reported no label; a surface then names the row by its state. */
  name: string
  agentType?: string
  model?: string
  detail: AgentChildRowDetail | null
  /** When the child was first seen: the elapsed anchor. */
  firstObservedAt: number
  /** Last evidence for THIS child. Absent from a host that reports none. */
  observedAt?: number
  /** The reader-clock time a "no update" reading measures from: the child's own evidence, else
   *  its parent's. */
  recencyAt: number
  settledAt?: number
  totalTokens?: number
  canStop: boolean
  settled: boolean
  /** Work this child owns (a nested agent, a shell it launched), in host order. */
  owned: AgentChildRowModel[]
}

export type AgentChildRowContext = {
  /** A stale parent makes every live claim beneath it unverifiable. */
  parentEvidenceFresh: boolean
  transportObservation: 'live' | 'unverifiable'
  /** The parent's last evidence on the READER's clock (its receipt time when mirrored from another
   *  host): recency for a child whose host reports no clock of its own. */
  parentObservedAt: number
  /** Reader clock minus the host's, at that evidence; 0 for a parent observed on this machine. Moves
   *  a child's host-stamped clock onto the reader's, so no age subtracts across two machines. */
  hostClockOffsetMs: number
}

/** The context a parent row gives its children. Every surface that lists one parent's children
 *  builds it here, from the same parent row, so a lost child reads the same everywhere. */
export function agentChildRowContextForParent(
  parent: Pick<
    AgentStatusEntry,
    'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt' | 'subagentObservation'
  >,
  parentEvidenceFresh: boolean
): AgentChildRowContext {
  // The parent row decays on this same clock, so a child's silence reads the same as its parent's.
  const parentObservedAt = agentStatusEvidenceObservedAt(parent)
  return {
    parentEvidenceFresh,
    transportObservation: parent.subagentObservation ?? 'live',
    parentObservedAt,
    hostClockOffsetMs: parentObservedAt - agentStatusAuthorityObservedAt(parent)
  }
}

/** Provider strings that carry no identity; the next label wins. */
const PLACEHOLDER_LABELS = new Set(['unknown', 'untitled', 'task', 'subagent'])

/** A provider label that names the child, or undefined for an empty or placeholder one. */
export function usableAgentChildLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && !PLACEHOLDER_LABELS.has(trimmed.toLowerCase()) ? trimmed : undefined
}

// A live claim beneath a parent Orca no longer hears from asserts nothing; settled history stands.
function withFreshness(
  displayState: AgentChildDisplayState,
  context: AgentChildRowContext
): AgentChildDisplayState {
  if (
    displayState === 'done' ||
    displayState === 'failed' ||
    displayState === 'interrupted' ||
    displayState === 'idle'
  ) {
    return displayState
  }
  return resolveAgentChildWorkFreshness({
    state: displayState,
    membership: 'live',
    parentEvidenceFresh: context.parentEvidenceFresh,
    transportObservation: context.transportObservation
  })
}

type AgentChildRowDetailSource = {
  /** `run-state`: the host reported only the child's run state (the legacy task roster). */
  evidence: 'child' | 'run-state'
  kind: AgentChildWorkKind
  name: string
  agentType?: string
  operation?: { toolName: string; input?: string }
  lastMessage?: string
  settled: boolean
}

// A role that restates the name adds nothing.
function roleDetail(source: AgentChildRowDetailSource): AgentChildRowDetail | null {
  if (source.kind !== 'agent') {
    return null
  }
  const agentType = source.agentType ?? 'unknown'
  return source.name.trim() === agentType.trim() ? null : { kind: 'role', agentType }
}

function messageOrRole(source: AgentChildRowDetailSource): AgentChildRowDetail | null {
  const text = source.lastMessage?.trim()
  return text ? { kind: 'message', text } : roleDetail(source)
}

/** The one rule for what a child row says, in the order a CLI agent row decides it. */
function agentChildRowDetail(
  source: AgentChildRowDetailSource,
  displayState: AgentChildDisplayState
): AgentChildRowDetail | null {
  if (source.evidence === 'run-state') {
    return displayState === 'waiting' ||
      displayState === 'blocked' ||
      displayState === 'unverifiable'
      ? { kind: 'reason', state: displayState }
      : null
  }
  switch (displayState) {
    case 'unverifiable':
      return { kind: 'no-update' }
    case 'monitoring':
      // A shell or monitor names itself; only an agent's own tool line goes stale.
      return source.kind === 'agent' ? { kind: 'monitoring' } : null
    case 'working':
    case 'waiting':
      return source.operation
        ? {
            kind: 'operation',
            toolName: source.operation.toolName,
            ...(source.operation.input !== undefined ? { input: source.operation.input } : {})
          }
        : messageOrRole(source)
    case 'blocked':
    case 'done':
    case 'failed':
      return messageOrRole(source)
    case 'interrupted':
      return roleDetail(source)
    case 'idle':
      return source.settled ? { kind: 'ended' } : roleDetail(source)
  }
}

function viewName(view: AgentChildWorkView): string {
  return (
    usableAgentChildLabel(view.description) ??
    usableAgentChildLabel(view.name) ??
    usableAgentChildLabel(view.agentType) ??
    ''
  )
}

function rowFromView(
  view: AgentChildWorkView,
  views: readonly AgentChildWorkView[],
  ownedByOwner: ReadonlyMap<string, AgentChildWorkView[]>,
  context: AgentChildRowContext,
  path: ReadonlySet<string>
): AgentChildRowModel {
  const displayState = withFreshness(
    deriveAgentChildDisplayState(view, agentChildWorkOwnedLiveness(views, view.id)),
    context
  )
  const settled = view.membership === 'settled'
  const name = viewName(view)
  const nextPath = new Set(path).add(view.id)
  return {
    id: view.id,
    ...(view.providerId !== undefined ? { providerId: view.providerId } : {}),
    kind: view.kind,
    displayState,
    name,
    ...(view.agentType !== undefined ? { agentType: view.agentType } : {}),
    ...(view.model !== undefined ? { model: view.model } : {}),
    detail: agentChildRowDetail(
      {
        evidence: 'child',
        kind: view.kind,
        name,
        agentType: view.agentType,
        operation: view.operation,
        lastMessage: view.lastMessage,
        settled
      },
      displayState
    ),
    firstObservedAt: view.firstObservedAt,
    observedAt: view.observedAt,
    recencyAt: view.observedAt + context.hostClockOffsetMs,
    ...(view.settledAt !== undefined ? { settledAt: view.settledAt } : {}),
    ...(view.totalTokens !== undefined ? { totalTokens: view.totalTokens } : {}),
    canStop: !settled && view.stoppable && view.providerId !== undefined,
    settled,
    owned: (ownedByOwner.get(view.id) ?? [])
      .filter((owned) => !nextPath.has(owned.id))
      .map((owned) => rowFromView(owned, views, ownedByOwner, context, nextPath))
  }
}

/**
 * Child rows from the host's views: the main agent's children at the top, and everything a child
 * owns nested beneath it. Display state comes from the shared child fold, so a finished subagent
 * whose shell still runs reads `monitoring` exactly as a CLI agent does.
 */
export function buildAgentChildRowModels(
  views: readonly AgentChildWorkView[],
  context: AgentChildRowContext
): AgentChildRowModel[] {
  const ownedByOwner = new Map<string, AgentChildWorkView[]>()
  for (const view of views) {
    if (view.parentChildWorkId !== undefined) {
      ownedByOwner.set(view.parentChildWorkId, [
        ...(ownedByOwner.get(view.parentChildWorkId) ?? []),
        view
      ])
    }
  }
  return views
    .filter((view) => view.parentChildWorkId === undefined)
    .map((view) => rowFromView(view, views, ownedByOwner, context, new Set()))
}

/**
 * Child rows from a host that sends only the legacy `subagents` snapshot (an old host, or any CLI
 * pane): live agents with a lifecycle state and a spawn time, and no clock of their own.
 */
export function buildLegacyAgentChildRowModels(
  subagents: readonly AgentSubagentSnapshot[],
  context: AgentChildRowContext
): AgentChildRowModel[] {
  return subagents.map((subagent) => {
    const displayState = withFreshness(
      deriveAgentChildDisplayState({ state: subagent.state, membership: 'live' }, null),
      context
    )
    const name =
      usableAgentChildLabel(subagent.description) ?? usableAgentChildLabel(subagent.agentType) ?? ''
    return {
      id: subagent.id,
      providerId: subagent.id,
      kind: 'agent',
      displayState,
      name,
      ...(subagent.agentType !== undefined ? { agentType: subagent.agentType } : {}),
      ...(subagent.model !== undefined ? { model: subagent.model } : {}),
      detail: agentChildRowDetail(
        { evidence: 'child', kind: 'agent', name, agentType: subagent.agentType, settled: false },
        displayState
      ),
      firstObservedAt: subagent.startedAt,
      recencyAt: context.parentObservedAt,
      canStop: false,
      settled: false,
      owned: []
    }
  })
}

function legacyTaskDisplayState(
  task: AgentSessionBackgroundTask,
  settled: boolean
): AgentChildDisplayState {
  if (task.state) {
    return task.state
  }
  if (settled) {
    return 'done'
  }
  return task.kind === 'monitor' ? 'monitoring' : 'working'
}

// The host decided each row's state; the row keeps it.
function legacyTaskRow(task: AgentSessionBackgroundTask, settled: boolean): AgentChildRowModel {
  const displayState = legacyTaskDisplayState(task, settled)
  const name = usableAgentChildLabel(task.description) ?? usableAgentChildLabel(task.name) ?? ''
  const startedAt = task.startedAt ?? 0
  return {
    id: task.id,
    providerId: task.id,
    kind: task.kind,
    displayState,
    name,
    detail: agentChildRowDetail(
      { evidence: 'run-state', kind: task.kind, name, settled },
      displayState
    ),
    firstObservedAt: startedAt,
    recencyAt: startedAt,
    ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {}),
    // Absent means stoppable: a host predating the field published only rows its stop could act on.
    canStop: task.stoppable !== false,
    settled,
    owned: []
  }
}

/**
 * Rows from a host that publishes only the session feed's task roster (a host predating child
 * views): flat, each with the run state the host decided and no clock beyond its start.
 */
export function buildLegacyTaskRowModels(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): AgentChildRowModel[] {
  // Older hosts can retain a previous turn beside its resumed live task; the live row wins.
  const rows = new Map<string, AgentChildRowModel>()
  for (const [roster, settled] of [
    [settledTasks, true],
    [tasks, false]
  ] as const) {
    for (const task of roster) {
      rows.set(task.id, legacyTaskRow(task, settled))
    }
  }
  return [...rows.values()]
}

/** Every row of a tree, owners before what they own. */
export function flattenAgentChildRowModels(
  rows: readonly AgentChildRowModel[]
): AgentChildRowModel[] {
  return rows.flatMap((row) => [row, ...flattenAgentChildRowModels(row.owned)])
}
