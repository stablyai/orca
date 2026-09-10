import type { OdooUser } from '../../../shared/odoo-types'
/** Beyond this the stack turns into `+N` so a crowded ticket cannot widen the header. */
export const ODOO_ASSIGNEE_STACK_CAP = 3

export type OdooAssigneeStack = {
  visible: OdooUser[]
  overflowCount: number
  /** Every assignee, in order — feeds the trigger's tooltip and aria-label. */
  names: string[]
  /** Only a lone assignee gets its name inline; a stack shows avatars only. */
  soleName: string | null
}

export function buildAssigneeStack(
  assignees: OdooUser[],
  cap: number = ODOO_ASSIGNEE_STACK_CAP
): OdooAssigneeStack {
  const visible = assignees.slice(0, Math.max(0, cap))
  return {
    visible,
    overflowCount: assignees.length - visible.length,
    names: assignees.map((user) => user.displayName),
    soleName: assignees.length === 1 ? assignees[0].displayName : null
  }
}
