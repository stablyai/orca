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

function renderList(
  listRoster: OrcaOrgMembersRoster,
  viewerUserId: string
): ReturnType<typeof render> {
  return render(
    <TeamMemberList
      rows={teamRows(listRoster, viewerUserId)}
      viewerRole={listRoster.viewerRole}
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
}

const rosterWithMfa: OrcaOrgMembersRoster = {
  ...roster,
  members: [
    { ...roster.members[0]!, mfa: 'on' },
    { ...roster.members[1]!, mfa: 'pending', mfaDeadline: Date.UTC(2026, 10, 24, 12) }
  ],
  pendingInvites: [{ email: 'alex@acme.dev', role: 'member', createdAt: Date.UTC(2026, 10, 17) }]
}

it.each(['owner', 'admin'] as const)('shows the MFA column to an %s', (viewerRole) => {
  const { container } = renderList({ ...rosterWithMfa, viewerRole }, 'u-neil')
  const cell = (key: string): Element =>
    container.querySelector(`[data-team-row="${key}"] [data-team-mfa]`)!
  expect(cell('member:u-neil').textContent).toBe('MFA on')
  expect(cell('member:u-grace').textContent).toBe('MFA due Nov 24')
  // A small muted badge, not bare text.
  expect(cell('member:u-neil').querySelector('[data-slot="badge"]')).not.toBeNull()
  // Invites keep an empty cell so the role column stays aligned.
  expect(cell('invite:alex@acme.dev').textContent).toBe('')
})

it('hides the MFA column from a plain member, even if a roster carried the status', () => {
  const { container } = renderList(
    { ...rosterWithMfa, viewerRole: 'member', canManageMembers: false },
    'u-grace'
  )
  expect(container.querySelector('[data-team-mfa]')).toBeNull()
  expect(container.textContent).not.toContain('MFA')
})

it('shows no MFA column when the server sent no status', () => {
  const { container } = renderList(roster, 'u-neil')
  expect(container.querySelector('[data-team-mfa]')).toBeNull()
})

it('leaves the cell blank, not "off", for a member with no status', () => {
  const { container } = renderList(
    {
      ...roster,
      members: [{ ...roster.members[0]!, mfa: 'off' }, roster.members[1]!]
    },
    'u-neil'
  )
  const cell = (key: string): Element =>
    container.querySelector(`[data-team-row="${key}"] [data-team-mfa]`)!
  expect(cell('member:u-neil').textContent).toBe('MFA off')
  expect(cell('member:u-grace').textContent).toBe('')
})
