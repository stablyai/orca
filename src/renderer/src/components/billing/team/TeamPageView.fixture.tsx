import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Dialog } from '@/components/ui/dialog'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import type { OrcaOrgMembersRoster } from '../../../../../shared/orca-profiles'
import { sampleTeam } from '../plan-billing-fixtures'
import { TeamDialogContent } from './TeamDialogHost'
import { TeamPageView, type TeamPageViewProps } from './TeamPageView'

const NOW = Date.UTC(2026, 10, 18, 15)
const DAY = 86_400_000
const width = 1100

const roster: OrcaOrgMembersRoster = {
  viewerRole: 'owner',
  canManageMembers: true,
  members: [
    { userId: 'u-neil', email: 'neil@acme.dev', displayName: 'Neil Parker', role: 'owner' },
    { userId: 'u-ada', email: 'ada@acme.dev', displayName: 'Ada Lovelace', role: 'admin' },
    { userId: 'u-grace', email: 'grace@acme.dev', displayName: 'Grace Hopper', role: 'member' },
    { userId: null, email: 'linus@acme.dev', role: 'member' }
  ],
  pendingInvites: [
    { email: 'alex@acme.dev', role: 'member', createdAt: NOW - 2 * DAY },
    { email: 'sam@acme.dev', role: 'admin', createdAt: NOW - 3 * 3600_000 }
  ]
}

const team: OrcaBillingEntitlement = {
  ...sampleTeam,
  seats: 4,
  period: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3) }
}
const noPlan: OrcaBillingEntitlement = {
  ...sampleTeam,
  plan: null,
  planLabel: null,
  status: 'none',
  interval: null,
  seats: 0,
  period: null,
  canStartSandbox: false,
  reason: 'no_subscription'
}

const noop = (): void => {}
const base: TeamPageViewProps = {
  org: { orgId: 'org-acme', name: 'Acme Engineering' },
  viewerUserId: 'u-neil',
  roster: { status: 'ok', roster },
  billing: { status: 'ok', entitlement: team },
  arrival: null,
  rowStates: {},
  refreshing: false,
  billingBusy: false,
  now: NOW,
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

function Page(props: Partial<TeamPageViewProps>): React.JSX.Element {
  return (
    <Dialog open modal={false}>
      <TeamDialogContent>
        <TeamPageView {...base} {...props} />
      </TeamDialogContent>
    </Dialog>
  )
}

export const ownerOnTeam = defineFixture({ width, render: () => <Page /> })

export const justUpgraded = defineFixture({
  width,
  render: () => <Page arrival={{ kind: 'checkout-success', seats: 4 }} />
})

export const noPlanUpgrade = defineFixture({
  width,
  render: () => <Page billing={{ status: 'ok', entitlement: noPlan }} />
})

export const memberReadOnly = defineFixture({
  width,
  render: () => (
    <Page
      viewerUserId="u-grace"
      roster={{
        status: 'ok',
        roster: { ...roster, viewerRole: 'member', canManageMembers: false, pendingInvites: [] }
      }}
      billing={{ status: 'ok', entitlement: { ...noPlan, canManageBilling: false } }}
    />
  )
})

export const rowBusyAndError = defineFixture({
  width,
  render: () => (
    <Page
      rowStates={{
        'member:u-grace': { busy: true },
        'invite:alex@acme.dev': {
          error: 'Too many team changes at once. Wait a minute and try again.'
        }
      }}
    />
  )
})

export const seatsDropAtRenewal = defineFixture({
  width,
  render: () => (
    <Page
      billing={{
        status: 'ok',
        entitlement: {
          ...team,
          seats: 5,
          seatChange: { seatsAtRenewal: 4, effectiveAt: Date.UTC(2026, 11, 3) }
        }
      }}
    />
  )
})

export const paymentFailed = defineFixture({
  width,
  render: () => (
    <Page
      billing={{
        status: 'ok',
        entitlement: {
          ...team,
          status: 'past_due',
          payment: { pastDueSince: NOW - DAY, graceEndsAt: NOW + 3 * DAY, suspendRunning: false },
          canStartSandbox: false,
          reason: 'payment_past_due'
        }
      }}
    />
  )
})

export const loading = defineFixture({ width, render: () => <Page roster={null} billing={null} /> })

export const loadFailed = defineFixture({
  width,
  render: () => (
    <Page
      roster={{ status: 'failed', error: 'timeout' }}
      billing={{ status: 'failed', error: 'x' }}
    />
  )
})

export const personalCreateTeam = defineFixture({
  width,
  render: () => (
    <Page
      org={null}
      create={{
        organizations: [
          { orgId: 'org-acme', name: 'Acme Engineering', role: 'Admin' },
          { orgId: 'org-oss', name: 'Open Source Club', role: 'Member' }
        ],
        creating: false,
        error: null,
        unavailable: false,
        switchingOrgId: null
      }}
    />
  )
})

export const createTeamUnsupported = defineFixture({
  width,
  render: () => (
    <Page
      org={null}
      create={{
        organizations: [],
        creating: false,
        error: null,
        unavailable: true,
        switchingOrgId: null
      }}
    />
  )
})

/** Pasted list mid-composition: valid chips, one invalid, and the seat impact line. */
export const invitePasted = defineFixture({
  width,
  render: () => <Page billing={{ status: 'ok', entitlement: { ...team, seats: 4 } }} />,
  interact: async () => {
    // The dialog portals to <body>, outside the fixture frame.
    const input = document.querySelector<HTMLInputElement>('input[inputmode="email"]')
    if (!input) {
      return
    }
    input.focus()
    // React listens for native input events; the trailing separator commits the chips.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, 'jordan@acme.dev, kim@acme.dev, not-an-email ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
