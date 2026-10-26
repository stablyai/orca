import { describe, expect, it } from 'vitest'
import { activeWorkingMembers } from './room-working-members'
import type { RoomMember } from './room-types'

const member = (overrides: Partial<RoomMember> = {}): RoomMember => ({
  memberId: 'm1',
  name: 'Alice',
  isAdmin: false,
  ...overrides
})

describe('activeWorkingMembers', () => {
  it('keeps a fresh busy member and expires a stale mark', () => {
    const now = Date.parse('2026-01-01T00:10:00Z')
    const members = [
      member({ name: 'Fresh', status: 'working', statusUpdatedAt: '2026-01-01T00:09:00Z' }),
      member({ name: 'Stale', status: 'working', statusUpdatedAt: '2025-12-31T23:00:00Z' }),
      member({ name: 'Idle', status: 'idle', statusUpdatedAt: '2026-01-01T00:09:00Z' })
    ]

    expect(activeWorkingMembers(members, now).map((entry) => entry.name)).toEqual(['Fresh'])
  })
})
