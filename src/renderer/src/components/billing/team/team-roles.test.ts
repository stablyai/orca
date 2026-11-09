import { describe, expect, it } from 'vitest'
import { assignableRoles, canActOnRole, canManageMembers } from './team-roles'

describe('team roles (mirrors auth org-roles)', () => {
  it('lets owners act on everyone, admins on admins and members, members on no one', () => {
    expect(canActOnRole('owner', 'owner')).toBe(true)
    expect(canActOnRole('admin', 'owner')).toBe(false)
    expect(canActOnRole('admin', 'admin')).toBe(true)
    expect(canActOnRole('admin', 'member')).toBe(true)
    expect(canActOnRole('member', 'member')).toBe(false)
    expect(canManageMembers('member')).toBe(false)
  })

  it('offers only assignable roles', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'member'])
    expect(assignableRoles('admin')).toEqual(['admin', 'member'])
    expect(assignableRoles('member')).toEqual([])
  })
})
