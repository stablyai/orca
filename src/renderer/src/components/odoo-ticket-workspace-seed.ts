import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import { slugifyForWorkspaceName } from '../../../shared/workspace-name'
import type { OdooTicket } from '../../../shared/odoo-types'
/** Mirrors getJiraIssueWorkspaceSeed's spirit (identifier + subject), using
 *  the ticket's `ref` (e.g. `#42`) in place of Jira's issue key. */
export function getOdooTicketWorkspaceSeed(ticket: OdooTicket): string {
  const refSlug = slugifyForWorkspaceName(ticket.ref)
  const titleSlug = getLinkedWorkItemSuggestedName({ title: ticket.title })
  return slugifyForWorkspaceName([refSlug, titleSlug].filter(Boolean).join('-'))
}
