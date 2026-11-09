import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaOrgMembersRoster } from '../../../../../shared/orca-profiles'
import { TeamMembersView } from './TeamMembersView'

const roster: OrcaOrgMembersRoster = {
  members: [
    { userId: 'u1', email: 'ada@acme.dev', displayName: 'Ada Lovelace', role: 'owner' },
    { userId: 'u2', email: 'grace@acme.dev', displayName: 'Grace Hopper', role: 'admin' },
    { userId: 'u3', email: 'linus@acme.dev', role: 'member' },
    { userId: null, email: 'sso-only@acme.dev', role: 'member' }
  ],
  pendingInvites: [
    { email: 'margaret@acme.dev', role: 'member', createdAt: Date.UTC(2026, 10, 7) }
  ],
  viewerRole: 'owner',
  canManageMembers: true
}

const handlers = {
  loading: false,
  busy: false,
  onRefresh: () => {},
  onInvite: () => {},
  onRevoke: () => {},
  onChangeRole: () => {},
  onRemove: () => {}
}

export const ownerView = defineFixture({
  width: 600,
  render: () => (
    <TeamMembersView
      {...handlers}
      notice={null}
      billedSeats={5}
      seatChange={{ seatsAtRenewal: 4, effectiveAt: Date.UTC(2026, 11, 3) }}
      viewerUserId="u1"
      result={{ status: 'ok', roster }}
    />
  )
})

export const memberView = defineFixture({
  width: 600,
  render: () => (
    <TeamMembersView
      {...handlers}
      notice={null}
      billedSeats={null}
      seatChange={null}
      viewerUserId="u3"
      result={{
        status: 'ok',
        roster: { ...roster, pendingInvites: [], viewerRole: 'member', canManageMembers: false }
      }}
    />
  )
})
