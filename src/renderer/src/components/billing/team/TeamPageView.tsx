import { useRef } from 'react'
import { LogOut, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
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
import { roleLabel } from './team-roles'
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

function SkeletonRows(): React.JSX.Element {
  return (
    <div
      aria-hidden
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 bg-card px-3 py-2.5">
          <span className="size-8 rounded-full bg-muted motion-safe:animate-pulse" />
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
              ? `${memberCountLabel(roster.members.length, t)} · ${t(
                  'auto.components.billing.team.youAre',
                  'You’re {{value0}}',
                  { value0: roleLabel(viewerRole, t).toLowerCase() }
                )}`
              : t('auto.components.billing.team.loading', 'Loading your team…')}
          </p>
        </div>
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
          onDismiss={props.onDismissArrival}
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
        <div
          aria-hidden
          className="h-[8.5rem] rounded-xl border border-border bg-muted/30 motion-safe:animate-pulse"
        />
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
        <div className="flex items-baseline justify-between gap-3">
          <h3 id="team-members-title" className="text-sm font-medium">
            {t('auto.components.billing.team.members', 'Members')}
          </h3>
          {roster && roster.pendingInvites.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('auto.components.billing.team.pendingCount', '{{value0}} invites pending', {
                value0: String(roster.pendingInvites.length)
              })}
            </p>
          ) : null}
        </div>
        {roster ? (
          <TeamMemberList
            rows={rows}
            viewerRole={viewerRole}
            rowStates={props.rowStates}
            canLeave={canLeave}
            now={props.now}
            onChangeRole={props.onChangeRole}
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
                    'auto.components.billing.team.loadFailed',
                    'Could not load your team. Try again.'
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!canLeave}
            onClick={props.onLeave}
          >
            <LogOut />
            {t('auto.components.billing.team.leaveCta', 'Leave team')}
          </Button>
        </section>
      ) : null}
    </div>
  )
}
