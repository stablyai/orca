import { useEffect } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { Dialog } from '@/components/ui/dialog'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import type { OrcaOrgMembersRoster } from '../../../../../shared/orca-profiles'
import { sampleTeam } from '../plan-billing-fixtures'
import { TeamDialogContent } from './TeamDialogHost'
import { TeamPageView, type TeamPageViewProps } from './TeamPageView'
import { TeamDeleteSection, type TeamDeleteCheck } from './TeamDeleteSection'
import { leaveTeamConfirmation } from './team-leave'

// Fixtures render offline: a self-contained stand-in for a provider profile picture.
const ADA_PICTURE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6c38f'/><stop offset='1' stop-color='%23c0713d'/></linearGradient></defs><rect width='64' height='64' fill='url(%23g)'/><circle cx='32' cy='26' r='12' fill='%23fff3e6'/><rect x='14' y='42' width='36' height='22' rx='11' fill='%23fff3e6'/></svg>"

const NOW = Date.UTC(2026, 10, 18, 15)
const DAY = 86_400_000
const width = 1100

const roster: OrcaOrgMembersRoster = {
  viewerRole: 'owner',
  canManageMembers: true,
  members: [
    { userId: 'u-neil', email: 'neil@acme.dev', displayName: 'Neil Parker', role: 'owner' },
    {
      userId: 'u-ada',
      email: 'ada@acme.dev',
      displayName: 'Ada Lovelace',
      role: 'admin',
      pictureUrl: ADA_PICTURE
    },
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
  onDismissArrival: noop,
  onOpenEnterprise: noop
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

/** TEAM-MODAL-CENTER: in a tall window the dialog sits in the middle, not pinned near the top. */
export const centeredInWindow = defineFixture({
  width,
  render: () => (
    <div className="h-[1000px]">
      <Page
        roster={{
          status: 'ok',
          roster: { ...roster, members: roster.members.slice(0, 2), pendingInvites: [] }
        }}
      />
    </div>
  )
})

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

// Billing sent no catalog (an older service or a failed read): no price is shown, never "$0".
export const noPriceKnown = defineFixture({
  width,
  render: () => <Page billing={{ status: 'ok', entitlement: { ...team, offers: null } }} />
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

/** Types into the invite field; the trailing separator commits the chips. */
async function typeInvites(text: string): Promise<void> {
  // The dialog portals to <body>, outside the fixture frame.
  const input = document.querySelector<HTMLInputElement>('input[inputmode="email"]')
  if (!input) {
    return
  }
  input.focus()
  // React listens for native input events.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))
}

/** Pasted list: the chips, one invalid entry, and the seat rule (no counts or prices). */
export const invitePasted = defineFixture({
  width,
  render: () => <Page billing={{ status: 'ok', entitlement: { ...team, seats: 4 } }} />,
  interact: () => typeInvites('jordan@acme.dev, kim@acme.dev, not-an-email ')
})

/** Short roster so the Enterprise row sits inside the frame. */
export const ssoRow = defineFixture({
  width,
  render: () => (
    <Page
      roster={{
        status: 'ok',
        roster: {
          ...roster,
          members: [roster.members[0]!, { ...roster.members[1]!, role: 'owner' }],
          pendingInvites: []
        }
      }}
    />
  )
})

/** The only owner opens the ⋯ on their own row: Leave is off and says what to do instead. */
export const lastOwnerLeaveBlocked = defineFixture({
  width,
  render: () => <Page />,
  interact: async () => {
    const trigger = document.querySelector<HTMLElement>(
      '[data-team-row="member:u-neil"] button[aria-haspopup="menu"]'
    )
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})

/** Choosing "Leave team…" from the ⋯ menu on your own row. */
function OpenLeaveConfirm(): null {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  useEffect(() => {
    void confirm(leaveTeamConfirmation('Orca Staging Eval Team', t))
  }, [confirm, t])
  return null
}

export const leaveConfirm = defineFixture({
  width: 560,
  render: () => (
    <div className="h-[300px]">
      <ConfirmationDialogProvider>
        <OpenLeaveConfirm />
      </ConfirmationDialogProvider>
    </div>
  )
})

// TEAM-DELETE: Settings › Team (inline), owner. The danger zone sits in the bottom card.
function DeletePage({ check }: { check: TeamDeleteCheck }): React.JSX.Element {
  // Settings › Team renders the page inline, not in the dialog, so the whole page shows.
  return (
    <div className="max-w-2xl p-6">
      <TeamPageView
        {...base}
        inline={{ onOpenPlanBilling: noop }}
        dangerZone={
          <TeamDeleteSection
            teamName="Acme Engineering"
            check={check}
            onDelete={noop}
            onBlockerAction={noop}
          />
        }
      />
    </div>
  )
}

export const deleteTeamAllowed = defineFixture({
  width,
  render: () => <DeletePage check={{ state: 'ready', blockers: [] }} />
})

export const deleteTeamBlockedPlan = defineFixture({
  width,
  render: () => (
    <DeletePage
      check={{ state: 'ready', blockers: [{ code: 'subscription_active', status: 'active' }] }}
    />
  )
})

export const deleteTeamBlockedOneWorkspace = defineFixture({
  width,
  render: () => (
    <DeletePage check={{ state: 'ready', blockers: [{ code: 'workspaces_exist', count: 1 }] }} />
  )
})

export const deleteTeamBlockedBoth = defineFixture({
  width,
  render: () => (
    <DeletePage
      check={{
        state: 'ready',
        blockers: [
          { code: 'subscription_active', status: 'trialing' },
          { code: 'workspaces_exist', count: 3 }
        ]
      }}
    />
  )
})
