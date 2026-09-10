import type { OdooPriority, OdooTicket } from '../../../shared/odoo-types'
/**
 * Which loaded tickets deserve a workspace of their own, without asking.
 *
 * Deliberately Odoo-only: the shared Automations engine has no notion of a
 * field filter (its precheck is a shell command) and no provider polling step,
 * so bending it to this would be a far larger change than the feature is worth.
 */
export type OdooAutoWorkspaceCriteria = {
  /** Only tickets assigned to the signed-in user. */
  assignedToMe: boolean
  /** Empty means any priority. */
  priorities: OdooPriority[]
  /** Only tickets whose stage id is listed. Empty means any stage. */
  stageIds: number[]
  /** Only tickets due within this many days. Null disables the check. */
  deadlineWithinDays: number | null
  /** Skip tickets with an empty description — usually not ready to work on. */
  requireDescription: boolean
}

export const DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA: OdooAutoWorkspaceCriteria = {
  assignedToMe: true,
  priorities: [],
  stageIds: [],
  deadlineWithinDays: null,
  requireDescription: false
}

function matchesDeadline(deadline: string | undefined, withinDays: number, now: number): boolean {
  if (!deadline) {
    return false
  }
  const due = new Date(deadline).getTime()
  if (Number.isNaN(due)) {
    return false
  }
  // Overdue counts: a passed deadline is the strongest reason to start.
  return due - now <= withinDays * 86_400_000
}

export function matchesOdooAutoWorkspaceCriteria(
  ticket: OdooTicket,
  criteria: OdooAutoWorkspaceCriteria,
  context: { viewerUid: number | undefined; now: number }
): boolean {
  if (criteria.assignedToMe) {
    if (context.viewerUid === undefined) {
      // Without a known viewer the filter cannot be honoured; refuse rather
      // than silently widening to every assignee.
      return false
    }
    if (!ticket.assignees.some((user) => user.id === context.viewerUid)) {
      return false
    }
  }
  if (criteria.priorities.length > 0 && !criteria.priorities.includes(ticket.priority)) {
    return false
  }
  if (criteria.stageIds.length > 0) {
    const stageId = ticket.stage?.id
    if (stageId === undefined || !criteria.stageIds.includes(stageId)) {
      return false
    }
  }
  if (
    criteria.deadlineWithinDays !== null &&
    !matchesDeadline(ticket.deadline, criteria.deadlineWithinDays, context.now)
  ) {
    return false
  }
  if (criteria.requireDescription && !(ticket.description ?? '').trim()) {
    return false
  }
  return true
}

export type OdooAutoWorkspaceSelection = {
  /** Tickets to create a workspace for, already capped. */
  selected: OdooTicket[]
  /** Matched but dropped by the cap — surfaced so the run is never silent. */
  droppedByCap: number
}

/**
 * Picks what to create this run.
 *
 * Two guards make an over-broad filter survivable: a ticket that already has a
 * linked workspace never re-triggers, and the per-run cap bounds how many
 * worktrees a single bad criterion can spawn.
 */
export function selectOdooAutoWorkspaceCandidates(
  tickets: readonly OdooTicket[],
  criteria: OdooAutoWorkspaceCriteria,
  context: {
    viewerUid: number | undefined
    now: number
    /** Ticket ids already linked to a workspace, or already handled. */
    excludedTicketIds: ReadonlySet<number>
    maxPerRun: number
  }
): OdooAutoWorkspaceSelection {
  if (context.maxPerRun <= 0) {
    return { selected: [], droppedByCap: 0 }
  }
  const matched = tickets.filter(
    (ticket) =>
      !context.excludedTicketIds.has(ticket.id) &&
      matchesOdooAutoWorkspaceCriteria(ticket, criteria, context)
  )
  return {
    selected: matched.slice(0, context.maxPerRun),
    droppedByCap: Math.max(0, matched.length - context.maxPerRun)
  }
}
