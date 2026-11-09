import { Crown, LogOut, MailPlus, MoreHorizontal, UserMinus, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { OrcaOrgMember, OrcaOrgRole } from '../../../../../shared/orca-profiles'
import { PersonAvatar } from './TeamAvatar'
import { memberStatusLabel, roleDescription } from './team-copy'
import { assignableRoles, roleLabel } from './team-roles'
import type { TeamRow } from './team-roster-rows'

export type TeamRowState = { busy?: boolean; error?: string }

export type TeamMemberListProps = {
  rows: TeamRow[]
  viewerRole: OrcaOrgRole
  rowStates: Readonly<Record<string, TeamRowState>>
  /** The viewer may leave (another owner exists, or they are not an owner). */
  canLeave: boolean
  now: number
  onChangeRole: (member: OrcaOrgMember, role: OrcaOrgRole) => void
  onMakeOwner: (member: OrcaOrgMember) => void
  onRemove: (member: OrcaOrgMember) => void
  onResend: (email: string, role: OrcaOrgRole) => void
  onRevoke: (email: string) => void
  onLeave: () => void
}

function relativeSince(then: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((then - now) / 60_000)
  if (Math.abs(minutes) < 60) {
    return format.format(Math.min(0, minutes), 'minute')
  }
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) {
    return format.format(hours, 'hour')
  }
  return format.format(Math.round(hours / 24), 'day')
}

function RoleControl({
  row,
  viewerRole,
  busy,
  onChange
}: {
  row: Extract<TeamRow, { kind: 'member' }>
  viewerRole: OrcaOrgRole
  busy: boolean
  onChange: (role: OrcaOrgRole) => void
}): React.JSX.Element {
  const t = useTranslate()
  const member = row.member
  if (!row.manageable) {
    return (
      <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
        {roleLabel(member.role, t)}
      </span>
    )
  }
  const roles = assignableRoles(viewerRole)
  return (
    <Select
      value={member.role}
      // Not disabled while saving: disabling would drop keyboard focus. Changes wait instead.
      onValueChange={(next) => {
        const role = roles.find((candidate) => candidate === next)
        if (role && role !== member.role && !busy) {
          onChange(role)
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-28 shrink-0"
        aria-disabled={busy || undefined}
        aria-label={t('auto.components.billing.team.roleFor', 'Role for {{value0}}', {
          value0: member.displayName ?? member.email
        })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {roles.map((role) => (
          <SelectItem key={role} value={role} title={roleDescription(role, t)}>
            {roleLabel(role, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function RowMenu({
  row,
  props
}: {
  row: TeamRow
  props: TeamMemberListProps
}): React.JSX.Element | null {
  const t = useTranslate()
  const name =
    row.kind === 'member' ? (row.member.displayName ?? row.member.email) : row.invite.email
  const items: React.ReactNode[] = []
  if (row.kind === 'invite' && row.manageable) {
    items.push(
      <DropdownMenuItem
        key="resend"
        onSelect={() => props.onResend(row.invite.email, row.invite.role)}
      >
        <MailPlus />
        {t('auto.components.billing.team.resend', 'Resend invite')}
      </DropdownMenuItem>,
      <DropdownMenuSeparator key="sep" />,
      <DropdownMenuItem
        key="revoke"
        variant="destructive"
        onSelect={() => props.onRevoke(row.invite.email)}
      >
        <XCircle />
        {t('auto.components.billing.team.revokeInvite', 'Revoke invite')}
      </DropdownMenuItem>
    )
  }
  if (row.kind === 'member' && row.manageable) {
    if (props.viewerRole === 'owner' && row.member.role !== 'owner') {
      items.push(
        <DropdownMenuItem key="owner" onSelect={() => props.onMakeOwner(row.member)}>
          <Crown />
          {t('auto.components.billing.team.makeOwner', 'Make owner…')}
        </DropdownMenuItem>,
        <DropdownMenuSeparator key="sep" />
      )
    }
    items.push(
      <DropdownMenuItem
        key="remove"
        variant="destructive"
        onSelect={() => props.onRemove(row.member)}
      >
        <UserMinus />
        {t('auto.components.billing.team.removeMember', 'Remove from team…')}
      </DropdownMenuItem>
    )
  }
  if (row.self) {
    items.push(
      <DropdownMenuItem
        key="leave"
        variant="destructive"
        disabled={!props.canLeave}
        onSelect={props.onLeave}
      >
        <LogOut />
        {t('auto.components.billing.team.leave', 'Leave team…')}
      </DropdownMenuItem>
    )
  }
  if (items.length === 0) {
    // Keeps the role column aligned with rows that have a menu.
    return <span aria-hidden className="size-7 shrink-0" />
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          aria-label={t('auto.components.billing.team.actionsFor', 'Actions for {{value0}}', {
            value0: name
          })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TeamMemberList(props: TeamMemberListProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  return (
    <ul
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
      aria-label={t('auto.components.billing.team.membersList', 'Team members and invites')}
    >
      {props.rows.map((row) => {
        const state = props.rowStates[row.key] ?? {}
        const name =
          row.kind === 'member' ? (row.member.displayName ?? row.member.email) : row.invite.email
        const secondary =
          row.kind === 'member'
            ? row.member.displayName
              ? row.member.email
              : null
            : t('auto.components.billing.team.invitedAgo', 'Invited {{value0}} as {{value1}}', {
                value0: relativeSince(row.invite.createdAt, props.now, locale),
                value1: roleLabel(row.invite.role, t).toLowerCase()
              })
        return (
          <li
            key={row.key}
            data-team-row={row.key}
            aria-busy={state.busy || undefined}
            className={cn(
              'group/row flex min-h-12 flex-col justify-center bg-card px-3 py-2 transition-colors animate-in fade-in-0 duration-200 motion-reduce:animate-none',
              state.busy && 'opacity-70'
            )}
          >
            <div className="flex items-center gap-3">
              <PersonAvatar name={name} pending={row.status !== 'active'} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate">{name}</span>
                  {row.self ? (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      {t('auto.components.billing.team.you', '(you)')}
                    </span>
                  ) : null}
                  {row.status === 'active' ? null : (
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
                        row.status === 'invited'
                          ? 'border-callout-note/40 bg-callout-note/10 text-callout-note'
                          : 'border-border text-muted-foreground'
                      )}
                    >
                      {memberStatusLabel(row.status, t)}
                    </span>
                  )}
                </p>
                {secondary ? (
                  <p className="truncate text-xs text-muted-foreground">{secondary}</p>
                ) : null}
              </div>
              {state.busy ? <LoadingSpinner className="size-3.5 shrink-0" /> : null}
              {row.kind === 'member' ? (
                <RoleControl
                  row={row}
                  viewerRole={props.viewerRole}
                  busy={Boolean(state.busy)}
                  onChange={(role) => props.onChangeRole(row.member, role)}
                />
              ) : (
                <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                  {roleLabel(row.invite.role, t)}
                </span>
              )}
              <RowMenu row={row} props={props} />
            </div>
            {state.error ? (
              <p role="alert" className="mt-1 pl-9 text-xs text-destructive">
                {state.error}
              </p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
