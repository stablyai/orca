import { describe, expect, it } from 'vitest'

import { ODOO_ASSIGNEE_STACK_CAP, buildAssigneeStack } from './odoo-ticket-assignee-stack'
import type { OdooUser } from '../../../shared/odoo-types'
function user(id: number): OdooUser {
  return { id, displayName: `User ${id}` }
}

function users(count: number): OdooUser[] {
  return Array.from({ length: count }, (_, index) => user(index + 1))
}

describe('buildAssigneeStack', () => {
  it('returns nothing to render for an unassigned ticket', () => {
    expect(buildAssigneeStack([])).toEqual({
      visible: [],
      overflowCount: 0,
      names: [],
      soleName: null
    })
  })

  it('keeps the name inline for a single assignee', () => {
    const stack = buildAssigneeStack([user(1)])
    expect(stack.visible).toHaveLength(1)
    expect(stack.overflowCount).toBe(0)
    expect(stack.soleName).toBe('User 1')
  })

  it('stacks avatars without a name once there are several assignees', () => {
    const stack = buildAssigneeStack(users(2))
    expect(stack.visible.map((entry) => entry.id)).toEqual([1, 2])
    expect(stack.overflowCount).toBe(0)
    expect(stack.soleName).toBeNull()
    expect(stack.names).toEqual(['User 1', 'User 2'])
  })

  it('caps the stack and counts the rest', () => {
    const stack = buildAssigneeStack(users(10))
    expect(stack.visible).toHaveLength(ODOO_ASSIGNEE_STACK_CAP)
    expect(stack.overflowCount).toBe(10 - ODOO_ASSIGNEE_STACK_CAP)
    // The tooltip still names everyone, not just the visible avatars.
    expect(stack.names).toHaveLength(10)
  })

  it('honours a custom cap', () => {
    const stack = buildAssigneeStack(users(5), 4)
    expect(stack.visible).toHaveLength(4)
    expect(stack.overflowCount).toBe(1)
  })
})
