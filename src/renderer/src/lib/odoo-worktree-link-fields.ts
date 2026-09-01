import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
export type OdooWorktreeLinkFields = {
  linkedOdooTicket: number
  linkedOdooInstanceId: string | null
}

/**
 * Derive the flat `linkedOdooTicket` / `linkedOdooInstanceId` worktree fields
 * from a work item link created for an Odoo ticket.
 *
 * Why: the Odoo stage sync (workspace-board-odoo-status-sync.ts) and the
 * sidebar card (WorktreeCard.tsx) read those two flat fields directly, not
 * `linkedWorkItem`, so a workspace created from an Odoo ticket must persist
 * both alongside the generic link.
 */
export function deriveOdooWorktreeLinkFields(
  linkedWorkItem:
    | Pick<WorkspaceLinkedItem, 'provider' | 'number' | 'odooInstanceId'>
    | null
    | undefined
): OdooWorktreeLinkFields | null {
  if (!linkedWorkItem || linkedWorkItem.provider !== 'odoo') {
    return null
  }
  return {
    linkedOdooTicket: linkedWorkItem.number,
    linkedOdooInstanceId: linkedWorkItem.odooInstanceId ?? null
  }
}
