// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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

it('points owners and admins to Settings › Enterprise with one plain button', () => {
  const onOpenEnterprise = vi.fn()
  for (const viewerRole of ['owner', 'admin'] as const) {
    render(
      <TeamPageView
        {...props}
        roster={{ status: 'ok', roster: { ...roster, viewerRole } }}
        onOpenEnterprise={onOpenEnterprise}
      />,
      { wrapper: TooltipProvider }
    )
    const row = screen.getByRole('region', { name: 'Single sign-on, SCIM and audit log' })
    // No Copy link split: the row has exactly one control.
    expect(row.querySelectorAll('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open Enterprise settings' }))
    cleanup()
  }
  expect(onOpenEnterprise).toHaveBeenCalledTimes(2)
})

it('hides the Enterprise row from plain members', () => {
  render(
    <TeamPageView
      {...props}
      roster={{
        status: 'ok',
        roster: { ...roster, viewerRole: 'member', canManageMembers: false }
      }}
      onOpenEnterprise={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  expect(screen.queryByText('Single sign-on, SCIM and audit log')).toBeNull()
})
