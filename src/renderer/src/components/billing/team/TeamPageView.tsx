import { useEffect, useRef } from 'react'
import { CreditCard, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { OrcaBillingStatusResult } from '../../../../../shared/orca-billing'
import type {
  OrcaOrgMember,
  OrcaOrgRole,
  OrcaProfileOrgMembersListResult
} from '../../../../../shared/orca-profiles'
import { TeamMark } from './TeamAvatar'
import { TeamCreateView, type TeamCreateViewProps } from './TeamCreateView'
import { TeamInviteComposer, type InviteBatchOutcome } from './TeamInviteComposer'
import { TeamMemberList, type TeamRowState } from './TeamMemberList'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { TeamCheckoutCelebration, TeamUpgradeCard } from './TeamPlanSummary'
import { memberCountLabel } from './team-copy'
import { leaveBlockedReason } from './team-leave'
import { otherOwnerCount, teamRows } from './team-roster-rows'
import { isActivePlan } from './team-seat-math'
import type { TeamPageArrival } from './team-page-store'

export type TeamPageViewProps = {
  /** The active team, or null on a personal account. */
  org: { orgId: string; name: string } | null
  viewerUserId: string | null
  roster: OrcaProfileOrgMembersListResult | null
  billing: OrcaBillingStatusResult | null
  arrival: TeamPageArrival
  rowStates: Readonly<Record<string, TeamRowState>>
  /** True only while a user-requested refresh runs (review M16: no spin on background reads). */
  refreshing: boolean
  billingBusy: boolean
  now: number
  create: Omit<TeamCreateViewProps, 'onCreate' | 'onSwitch'>
  onCreateTeam: (name: string) => void
  onSwitchOrg: (orgId: string) => void
  onRefresh: () => void
  onInvite: (emails: string[], role: OrcaOrgRole) => Promise<InviteBatchOutcome>
  onChangeRole: (member: OrcaOrgMember, role: OrcaOrgRole) => void
  onMakeOwner: (member: OrcaOrgMember) => void
  onRemove: (member: OrcaOrgMember) => void
  onResend: (email: string, role: OrcaOrgRole) => void
  onRevoke: (email: string) => void
  onLeave: () => void
  onOpenProfile?: (userId: string) => void
  onSeePlans: () => void
  onManageBilling: () => void
  onCreateWorkspace: () => void
  onDismissArrival: () => void
  /** Settings → Team renders the page inline: seats and invoices stay on Plan & billing (linked). */
  inline?: { onOpenPlanBilling: () => void }
  /** Owners in Settings › Team: "Delete <team>", after "Leave <team>" (TEAM-DELETE). */
  dangerZone?: React.ReactNode
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div
      aria-hidden
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 bg-card px-3 py-2">
          <Skeleton shape="circle" className="size-6" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-44" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  )
}

export function TeamPageView(props: TeamPageViewProps): React.JSX.Element {
  const t = useTranslate()
  const inviteInput = useRef<HTMLInputElement>(null)
  const hasRoster = props.roster !== null
  const inline = props.inline ?? null
  useEffect(() => {
    const active = document.activeElement
    if (
      !inline &&
      hasRoster &&
      (!active || active === document.body || active.getAttribute('role') === 'dialog')
    ) {
      document.querySelector<HTMLElement>('[data-team-page-heading]')?.focus()
    }
  }, [hasRoster, inline])

  if (!props.org) {
    return (
      <TeamCreateView
        {...props.create}
        onCreate={props.onCreateTeam}
        onSwitch={props.onSwitchOrg}
      />
    )
  }

  const roster = props.roster?.status === 'ok' ? props.roster.roster : null
  const entitlement = props.billing?.status === 'ok' ? props.billing.entitlement : null
  const rows = roster ? teamRows(roster, props.viewerUserId) : []
  const selfRow = rows.find((row) => row.self)
  const viewerRole = roster?.viewerRole ?? 'member'
  const canLeave =
    Boolean(selfRow) &&
    (viewerRole !== 'owner' || (roster ? otherOwnerCount(roster, props.viewerUserId) > 0 : false))

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <TeamMark name={props.org.name} />
        <div className="min-w-0 flex-1">
          <h2
            data-team-page-heading=""
            tabIndex={-1}
            className="truncate text-lg font-semibold tracking-tight outline-none"
          >
            {props.org.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {roster
              ? [
                  memberCountLabel(roster.members.length, t),
                  roster.pendingInvites.length > 0
                    ? t('auto.components.billing.team.invitedCount', '{{count}} invited', {
                        count: roster.pendingInvites.length
                      })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              : props.roster === null
                ? t('auto.components.billing.team.loading', 'Loading your team…')
                : t('auto.components.billing.team.loadFailedTitle', 'Couldn’t load team')}
          </p>
        </div>
        {!inline && entitlement?.canManageBilling ? (
          // Seats, prices and invoices live in Plan & billing; one quiet way there from here.
          // mr-6 clears the dialog's close button, which sits in this corner.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mr-6 shrink-0"
            onClick={props.onSeePlans}
          >
            <CreditCard />
            {t('auto.components.billing.team.planBillingLink', 'Plan & billing')}
          </Button>
        ) : null}
      </header>

      {props.arrival?.kind === 'checkout-success' && entitlement ? (
        <TeamCheckoutCelebration
          seats={entitlement.seats || props.arrival.seats}
          planLabel={entitlement.planLabel ?? 'Team'}
          onCreateWorkspace={props.onCreateWorkspace}
          onInvite={() => {
            props.onDismissArrival()
            inviteInput.current?.focus()
          }}
          onDismiss={() => {
            props.onDismissArrival()
            // The focused dismiss button unmounts; keep focus on something real.
            ;(inviteInput.current ?? document.getElementById('team-members-title'))?.focus()
          }}
        />
      ) : null}

      {inline ? (
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          {t('auto.components.billing.team.seatsOnPlanBilling', 'Seats and invoices are in')}
          <button
            type="button"
            className="rounded-sm text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={inline.onOpenPlanBilling}
          >
            {t('settings.accountBilling.title2', 'Account & billing')}
          </button>
        </p>
      ) : entitlement ? (
        <>
          <PaymentIssueNotice
            entitlement={entitlement}
            busy={props.billingBusy}
            onUpdatePayment={props.onManageBilling}
          />
          {isActivePlan(entitlement) ? null : (
            <TeamUpgradeCard entitlement={entitlement} onSeePlans={props.onSeePlans} />
          )}
        </>
      ) : null}

      {props.roster === null ? (
        <div aria-hidden className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <div className="flex gap-2">
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : null}

      {roster?.canManageMembers ? (
        <TeamInviteComposer
          viewerRole={viewerRole}
          entitlement={entitlement}
          members={roster.members.length}
          pendingInvites={roster.pendingInvites.length}
          now={props.now}
          onInvite={props.onInvite}
          inputRef={inviteInput}
        />
      ) : null}

      <section aria-labelledby="team-members-title" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 id="team-members-title" tabIndex={-1} className="text-sm font-medium outline-none">
            {t('auto.components.billing.team.members', 'Members')}
          </h3>
          {roster ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={props.refreshing ? undefined : props.onRefresh}
              aria-disabled={props.refreshing || undefined}
              aria-label={t('auto.components.billing.team.refresh', 'Refresh team')}
            >
              <RefreshCw className={cn(props.refreshing && 'motion-safe:animate-spin')} />
            </Button>
          ) : null}
        </div>
        {roster ? (
          <TeamMemberList
            rows={rows}
            viewerRole={viewerRole}
            rowStates={props.rowStates}
            canLeave={canLeave}
            leaveBlockedReason={leaveBlockedReason(
              { canLeave, canDeleteTeam: Boolean(props.dangerZone) },
              t
            )}
            now={props.now}
            // Promoting to owner hands over billing control, so it always confirms first.
            onChangeRole={(member, role) =>
              role === 'owner' ? props.onMakeOwner(member) : props.onChangeRole(member, role)
            }
            onMakeOwner={props.onMakeOwner}
            onRemove={props.onRemove}
            onResend={props.onResend}
            onRevoke={props.onRevoke}
            onLeave={props.onLeave}
            onOpenProfile={props.onOpenProfile}
          />
        ) : props.roster === null ? (
          <SkeletonRows />
        ) : (
          <InlineError
            title={t('auto.components.billing.team.loadFailedTitle', 'Couldn’t load team')}
            detail={
              props.roster.status === 'reconnect-required'
                ? t(
                    'auto.components.billing.openSignedOut2',
                    'Sign in to Orca again to manage your team.'
                  )
                : t(
                    'auto.components.billing.team.loadFailed2',
                    'Couldn’t load your team. Check your connection.'
                  )
            }
            retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
            onRetry={props.onRefresh}
            retrying={props.refreshing}
          />
        )}
        {roster && !roster.canManageMembers ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.billing.team.readOnly',
              'Only owners and admins can invite people or change roles.'
            )}
          </p>
        ) : null}
      </section>

      {props.dangerZone ? (
        <div className="divide-y divide-border/60 rounded-xl border border-border">
          {props.dangerZone}
        </div>
      ) : null}
    </div>
  )
}
