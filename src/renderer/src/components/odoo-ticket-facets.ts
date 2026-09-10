import type { OdooPriority, OdooTicket } from '../../../shared/odoo-types'
export type OdooTicketFacetOption = { id: number; label: string }

export type OdooTicketFacets = {
  stages: string[]
  assignees: OdooTicketFacetOption[]
  tags: OdooTicketFacetOption[]
}

export type OdooTicketListFilters = {
  /** Selected stage names; empty means every stage, like Odoo's own facets. */
  stages: string[]
  priority: OdooPriority | 'all'
  assignee: string
  tag: string
}

/**
 * Sentinel assignee value matching tickets nobody owns. Odoo has no user id to
 * select for that, so the filter needs its own token alongside 'all'.
 */
export const ODOO_UNASSIGNED_FILTER = 'unassigned'

export const DEFAULT_ODOO_TICKET_FILTERS: OdooTicketListFilters = {
  stages: [],
  priority: 'all',
  assignee: 'all',
  tag: 'all'
}

function toSortedOptions(source: Map<number, string>): OdooTicketFacetOption[] {
  return [...source.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Derives the assignee/tag/stage filter options present in the loaded set. */
export function deriveOdooTicketFacets(tickets: OdooTicket[]): OdooTicketFacets {
  const stages = new Set<string>()
  const assignees = new Map<number, string>()
  const tags = new Map<number, string>()
  for (const ticket of tickets) {
    if (ticket.stage) {
      stages.add(ticket.stage.name)
    }
    for (const user of ticket.assignees) {
      if (!assignees.has(user.id)) {
        assignees.set(user.id, user.displayName)
      }
    }
    for (const tag of ticket.tags) {
      if (!tags.has(tag.id)) {
        tags.set(tag.id, tag.name)
      }
    }
  }
  return {
    stages: [...stages].sort((a, b) => a.localeCompare(b)),
    assignees: toSortedOptions(assignees),
    tags: toSortedOptions(tags)
  }
}

/**
 * Client-side narrowing of the loaded set. 'all' (or an empty stage selection)
 * means the facet is inactive; several stages read as a union, the rest as a
 * conjunction — same semantics as Odoo's search panel.
 */
export function filterOdooTickets(
  tickets: OdooTicket[],
  filters: OdooTicketListFilters
): OdooTicket[] {
  const stages = filters.stages
  return tickets.filter(
    (ticket) =>
      (stages.length === 0 || (ticket.stage !== undefined && stages.includes(ticket.stage.name))) &&
      (filters.priority === 'all' || ticket.priority === filters.priority) &&
      (filters.assignee === 'all' ||
        (filters.assignee === ODOO_UNASSIGNED_FILTER
          ? ticket.assignees.length === 0
          : ticket.assignees.some((user) => String(user.id) === filters.assignee))) &&
      (filters.tag === 'all' || ticket.tags.some((tag) => String(tag.id) === filters.tag))
  )
}
