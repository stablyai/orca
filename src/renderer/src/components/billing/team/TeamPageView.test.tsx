// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrcaOrgMembersRoster } from '../../../../../shared/orca-profiles'
import { sampleTeam } from '../plan-billing-fixtures'
import { TeamPageView, type TeamPageViewProps } from './TeamPageView'

afterEach(cleanup)

const roster: OrcaOrgMembersRoster = {
  viewerRole: 'owner',
  canManageMembers: true,
  members: [
    { userId: 'u-neil', email: 'neil@acme.dev', displayName: 'Neil Parker', role: 'owner' },
    { userId: 'u-ada', email: 'ada@acme.dev', displayName: 'Ada Lovelace', role: 'admin' }
  ],
  pendingInvites: [{ email: 'sam@acme.dev', role: 'member', createdAt: 0 }]
}

const noop = (): void => {}
const props: TeamPageViewProps = {
  org: { orgId: 'org-acme', name: 'Acme Engineering' },
  viewerUserId: 'u-neil',
  roster: { status: 'ok', roster },
  billing: { status: 'ok', entitlement: { ...sampleTeam, canManageBilling: true } },
  arrival: null,
  rowStates: {},
  refreshing: false,
  billingBusy: false,
  now: 0,
  create: {
    organizations: [],
    creating: false,
    error: null,
    unavailable: false,
    switchingOrgId: null
  },
  onCreateTeam: noop,
  onSwitchOrg: noop,
  onRefresh: noop,
  onInvite: async () => ({ failed: [] }),
  onChangeRole: noop,
  onMakeOwner: noop,
  onRemove: noop,
  onResend: noop,
  onRevoke: noop,
  onLeave: noop,
  onSeePlans: noop,
  onManageBilling: noop,
  onCreateWorkspace: noop,
  onDismissArrival: noop
}

it('keeps the header to the name and counts: no role sentence, no Plan & billing button', () => {
  render(<TeamPageView {...props} />, { wrapper: TooltipProvider })
  const header = document.querySelector('header')!
  expect(header.textContent).toContain('2 members · 1 invited')
  expect(header.textContent).not.toMatch(/You’re an|Plan & billing/)
  expect(header.querySelector('button')).toBeNull()
  // Seat counts and prices live only in Plan & billing.
  expect(screen.queryByText(/open seat/)).toBeNull()
})
