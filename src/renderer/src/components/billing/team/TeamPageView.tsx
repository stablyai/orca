import { useRef } from 'react'
import { LogOut, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsDisabledControlTooltip } from '@/components/settings/form-controls/SettingsDisabledControlTooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
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
import { TeamBillingBlock, TeamCheckoutCelebration } from './TeamPlanSummary'
import { memberCountLabel } from './team-copy'
import { otherOwnerCount, teamRows } from './team-roster-rows'
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
  onSeePlans: () => void
  onManageBilling: () => void
  onCreateWorkspace: () => void
  onDismissArrival: () => void
}

function viewerRoleSentence(role: OrcaOrgRole, t: Translate): string {
  switch (role) {
    case 'owner':
      return t('auto.components.billing.team.youAreOwner', 'You’re an owner')
    case 'admin':
      return t('auto.components.billing.team.youAreAdmin', 'You’re an admin')
    case 'member':
      return t('auto.components.billing.team.youAreMember', 'You’re a member')
  }
}

/** Mirrors the plan card (title + badge, three stats, a two-line note) so loading doesn't jump. */
function PlanSkeleton(): React.JSX.Element {
  const bar = 'block rounded bg-muted motion-safe:animate-pulse'
  return (
    <div aria-hidden className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2">
        <span className={`${bar} h-4 w-12`} />
        <span className={`${bar} h-5 w-14 rounded-full`} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((index) => (
          <span key={index} className="space-y-1.5">
            <span className={`${bar} h-3 w-16`} />
            <span className={`${bar} h-4 w-12`} />
            <span className={`${bar} h-3 w-24`} />
          </span>
        ))}
      </div>
      <span className={`${bar} h-3 w-11/12`} />
      <span className={`${bar} h-3 w-2/3`} />
    </div>
  )
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div
      aria-hidden
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 bg-card px-3 py-2">
          <span className="size-6 rounded-full bg-muted motion-safe:animate-pulse" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-3 w-32 rounded bg-muted motion-safe:animate-pulse" />
            <span className="block h-2.5 w-44 rounded bg-muted/70 motion-safe:animate-pulse" />
          </span>
          <span className="h-8 w-24 rounded-md bg-muted/70 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export function TeamPageView(props: TeamPageViewProps): React.JSX.Element {
  const t = useTranslate()
  const inviteInput = useRef<HTMLInputElement>(null)

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
          <h2 className="truncate text-lg font-semibold tracking-tight">{props.org.name}</h2>
          <p className="text-xs text-muted-foreground">
            {roster
              ? [
                  memberCountLabel(roster.members.length, t),
                  roster.pendingInvites.length > 0
                    ? t('auto.components.billing.team.invitedN', '{{value0}} invited', {
                        value0: String(roster.pendingInvites.length)
                      })
                    : null,
                  viewerRoleSentence(viewerRole, t)
                ]
                  .filter(Boolean)
                  .join(' · ')
              : props.roster === null
                ? t('auto.components.billing.team.loading', 'Loading your team…')
                : t('auto.components.billing.team.loadFailedTitle', 'Couldn’t load team')}
          </p>
        </div>
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

      {entitlement ? (
        <TeamBillingBlock
          entitlement={entitlement}
          members={roster?.members.length ?? 0}
          busy={props.billingBusy}
          onManageBilling={props.onManageBilling}
          onSeePlans={props.onSeePlans}
        />
      ) : props.billing === null ? (
        <PlanSkeleton />
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
              onClick={props.onRefresh}
              disabled={props.refreshing}
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
          />
        ) : props.roster === null ? (
          <SkeletonRows />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {props.roster.status === 'reconnect-required'
                ? t(
                    'auto.components.billing.openSignedOut',
                    'Sign in to Orca again to manage billing.'
                  )
                : t(
                    'auto.components.billing.team.loadFailed2',
                    'Couldn’t load your team. Check your connection.'
                  )}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={props.onRefresh}>
              <RefreshCw />
              {t('auto.components.billing.plans.retry', 'Try again')}
            </Button>
          </div>
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

      {selfRow ? (
        <section
          aria-labelledby="team-leave-title"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"
        >
          <div className="min-w-[14rem] flex-1 space-y-0.5">
            <h3 id="team-leave-title" className="text-sm font-medium">
              {t('auto.components.billing.team.leaveTitle', 'Leave {{value0}}', {
                value0: props.org.name
              })}
            </h3>
            <p className="text-xs text-muted-foreground text-pretty">
              {canLeave
                ? t(
                    'auto.components.billing.team.leaveBody',
                    'You lose access to the team’s cloud workspaces and secrets. An admin can invite you back.'
                  )
                : t(
                    'auto.components.billing.team.leaveLastOwner',
                    'You’re the only owner. Make someone else an owner first.'
                  )}
            </p>
          </div>
          <SettingsDisabledControlTooltip
            reason={
              canLeave
                ? undefined
                : t(
                    'auto.components.billing.team.leaveNeedsOwner',
                    'Make someone else an owner first'
                  )
            }
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canLeave}
              onClick={props.onLeave}
            >
              <LogOut />
              {t('auto.components.billing.team.leaveCta', 'Leave team')}
            </Button>
          </SettingsDisabledControlTooltip>
        </section>
      ) : null}
    </div>
  )
}
