// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { OrcaOrgMembersRoster } from '../../../../../shared/orca-profiles'
import { TeamMemberList } from './TeamMemberList'
import { teamRows } from './team-roster-rows'

afterEach(cleanup)

const roster: OrcaOrgMembersRoster = {
  viewerRole: 'owner',
  canManageMembers: true,
  members: [
    { userId: 'u-neil', email: 'neil@acme.dev', displayName: 'Neil Parker', role: 'owner' },
    { userId: 'u-grace', email: 'grace@acme.dev', displayName: 'Grace Hopper', role: 'member' }
  ],
  pendingInvites: []
}

const noop = (): void => {}

it('marks a busy row with aria-busy and a spinner, without dimming it', () => {
  const { container } = render(
    <TeamMemberList
      rows={teamRows(roster, 'u-neil')}
      viewerRole="owner"
      rowStates={{ 'member:u-grace': { busy: true } }}
      canLeave
      now={Date.UTC(2026, 10, 18)}
      onChangeRole={noop}
      onMakeOwner={noop}
      onRemove={noop}
      onResend={noop}
      onRevoke={noop}
      onLeave={noop}
    />
  )
  const busy = container.querySelector('[data-team-row="member:u-grace"]')!
  const idle = container.querySelector('[data-team-row="member:u-neil"]')!
  expect(busy.getAttribute('aria-busy')).toBe('true')
  expect(idle.hasAttribute('aria-busy')).toBe(false)
  // Dimming dropped the email under AA; the row keeps full opacity.
  expect(busy.className).not.toMatch(/opacity-/)
  expect(busy.querySelector('.animate-spin')).not.toBeNull()
  expect(idle.querySelector('.animate-spin')).toBeNull()
})

it('offers Leave from the ⋯ on your own row only', () => {
  const { container } = render(
    <TeamMemberList
      rows={teamRows({ ...roster, viewerRole: 'member', canManageMembers: false }, 'u-grace')}
      viewerRole="member"
      rowStates={{}}
      canLeave
      now={Date.UTC(2026, 10, 18)}
      onChangeRole={noop}
      onMakeOwner={noop}
      onRemove={noop}
      onResend={noop}
      onRevoke={noop}
      onLeave={noop}
    />
  )
  const self = container.querySelector('[data-team-row="member:u-grace"]')!
  const other = container.querySelector('[data-team-row="member:u-neil"]')!
  expect(self.querySelector('button[aria-label^="Actions for"]')).not.toBeNull()
  // A plain member has nothing to do on someone else's row.
  expect(other.querySelector('button[aria-label^="Actions for"]')).toBeNull()
})
