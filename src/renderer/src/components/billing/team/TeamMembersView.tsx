import { useState } from 'react'
import { Mail, RefreshCw, UserMinus, UserPlus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  OrcaOrgMember,
  OrcaOrgRole,
  OrcaProfileOrgMembersListResult
} from '../../../../../shared/orca-profiles'
import { assignableRoles, canActOnRole, roleLabel } from './team-roles'

export type TeamMembersViewProps = {
  result: OrcaProfileOrgMembersListResult | null
  loading: boolean
  busy: boolean
  notice: string | null
  /** Seats Team bills (from billing), or null when there is no plan or billing is off. */
  billedSeats: number | null
  /** Seats paid this period stay until renewal, then drop to the member count. */
  seatChange: { seatsAtRenewal: number; effectiveAt: number } | null
  viewerUserId: string | null
  onRefresh: () => void
  onInvite: (email: string, role: OrcaOrgRole) => void
  onRevoke: (email: string) => void
  onChangeRole: (member: OrcaOrgMember, role: OrcaOrgRole) => void
  onRemove: (member: OrcaOrgMember) => void
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function RoleSelect({
  value,
  roles,
  disabled,
  onChange,
  label
}: {
  value: OrcaOrgRole
  roles: OrcaOrgRole[]
  disabled: boolean
  onChange: (role: OrcaOrgRole) => void
  label: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const role = roles.find((candidate) => candidate === next)
        if (role) {
          onChange(role)
        }
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role} value={role}>
            {roleLabel(role, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TeamMembersView(props: TeamMembersViewProps): React.JSX.Element {
  const t = useTranslate()
  const { result, loading, busy, notice, billedSeats } = props
  const locale = useIntlLocale()
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrcaOrgRole>('member')

  const header = (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('auto.components.billing.team.title', 'Team')}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={loading}
        onClick={props.onRefresh}
        aria-label={t('auto.components.billing.team.refresh', 'Refresh team')}
      >
        <RefreshCw className={cn(loading && 'animate-spin')} />
      </Button>
    </div>
  )

  if (!result || result.status !== 'ok') {
    return (
      <div className="space-y-3 border-t border-border/60 pt-5">
        {header}
        <p className="text-xs text-muted-foreground">
          {result === null
            ? t('auto.components.billing.team.loading', 'Loading your team…')
            : t('auto.components.billing.team.loadFailed', 'Could not load your team. Try again.')}
        </p>
      </div>
    )
  }

  const roster = result.roster
  const manager = roster.canManageMembers
  const roles = assignableRoles(roster.viewerRole)
  const emailValid = EMAIL.test(email.trim())

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      {header}
      <p className="text-xs text-muted-foreground">
        {billedSeats === null
          ? t('auto.components.billing.team.memberCount', '{{value0}} members', {
              value0: String(roster.members.length)
            })
          : t(
              'auto.components.billing.team.memberSeats',
              '{{value0}} members · {{value1}} seats billed. Seats follow membership; pending invites are free until accepted.',
              { value0: String(roster.members.length), value1: String(billedSeats) }
            )}
        {props.seatChange
          ? ` ${t(
              'auto.components.billing.team.seatsDrop',
              'Seats paid this period stay until {{value0}}, then drop to {{value1}}.',
              {
                value0: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                  props.seatChange.effectiveAt
                ),
                value1: String(props.seatChange.seatsAtRenewal)
              }
            )}`
          : null}
      </p>

      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {roster.members.map((member) => {
          const self = member.userId !== null && member.userId === props.viewerUserId
          const actionable =
            manager &&
            !self &&
            member.userId !== null &&
            canActOnRole(roster.viewerRole, member.role)
          return (
            <li key={member.email} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.displayName ?? member.email}
                  {self ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t('auto.components.billing.team.you', '(you)')}
                    </span>
                  ) : null}
                </p>
                {member.displayName ? (
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                ) : null}
              </div>
              {actionable ? (
                <RoleSelect
                  value={member.role}
                  roles={roles}
                  disabled={busy}
                  onChange={(role) => props.onChangeRole(member, role)}
                  label={t('auto.components.billing.team.roleFor', 'Role for {{value0}}', {
                    value0: member.email
                  })}
                />
              ) : (
                <Badge variant="outline">{roleLabel(member.role, t)}</Badge>
              )}
              {actionable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  onClick={() => props.onRemove(member)}
                  aria-label={t('auto.components.billing.team.remove', 'Remove {{value0}}', {
                    value0: member.email
                  })}
                >
                  <UserMinus />
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {manager && roster.pendingInvites.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">
            {t('auto.components.billing.team.pending', 'Pending invites')}
          </p>
          <ul className="divide-y divide-border/60 rounded-md border border-dashed border-border/60">
            {roster.pendingInvites.map((invite) => (
              <li key={invite.email} className="flex items-center gap-3 px-3 py-2">
                <Mail className="size-4 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-sm">{invite.email}</p>
                <Badge variant="outline">{roleLabel(invite.role, t)}</Badge>
                {canActOnRole(roster.viewerRole, invite.role) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => props.onRevoke(invite.email)}
                  >
                    {t('auto.components.billing.team.revoke', 'Revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {manager ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (emailValid) {
              props.onInvite(email.trim(), inviteRole)
              setEmail('')
            }
          }}
        >
          <div className="min-w-48 flex-1">
            <Input
              type="email"
              placeholder={t(
                'auto.components.billing.team.invitePlaceholder',
                'teammate@company.com'
              )}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-label={t('auto.components.billing.team.inviteEmail', 'Email to invite')}
            />
          </div>
          <RoleSelect
            value={inviteRole}
            roles={roles}
            disabled={busy}
            onChange={setInviteRole}
            label={t('auto.components.billing.team.inviteRole', 'Role for the invite')}
          />
          <Button type="submit" size="sm" disabled={busy || !emailValid}>
            <UserPlus />
            {t('auto.components.billing.team.invite', 'Invite')}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.billing.team.askAdmin',
            'Only owners and admins can invite or remove members.'
          )}
        </p>
      )}

      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  )
}
