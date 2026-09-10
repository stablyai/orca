import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeAttachmentLabel } from './worktree-attachment-label'

/** Mirrors findGithubIssueWorkspaceAttachment: a ticket is only addressable
 *  per Odoo instance, so both the ticket id and the instance id must match. */
export function findOdooTicketWorkspaceAttachment(
  worktrees: readonly Worktree[],
  ticketId: number,
  instanceId: string | null | undefined
): Worktree | null {
  return (
    worktrees.find((worktree) => {
      if (worktree.isArchived || worktree.linkedOdooTicket !== ticketId) {
        return false
      }
      return (worktree.linkedOdooInstanceId ?? null) === (instanceId ?? null)
    }) ?? null
  )
}

export function getOdooTicketWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorktreeAttachmentLabel(worktree)
}
