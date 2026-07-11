import { useState } from 'react'
import { Loader2, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { OrcaOrgMember, OrcaOrgRole } from '../../../../shared/orca-profiles'
import {
  ORG_ROLE_OPTIONS,
  orgMemberInitials,
  orgRoleLabel
} from './orca-profile-org-members-labels'

export function OrcaProfileOrgMemberRow({
  member,
  canManage,
  isSelf,
  busy,
  onChangeRole,
  onRemove
}: {
  member: OrcaOrgMember
  canManage: boolean
  isSelf: boolean
  busy: boolean
  onChangeRole: (role: OrcaOrgRole) => void
  onRemove: () => void
}): React.JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // Why: teammates provisioned server-side who never signed into Orca have no
  // userId, so the API cannot target them for role/remove mutations.
  const neverSignedIn = member.userId === null
  const actionsDisabled = !canManage || isSelf || neverSignedIn || busy
  const displayName = member.displayName?.trim() || member.email

  const roleControl = canManage ? (
    <Select
      value={member.role}
      disabled={actionsDisabled}
      onValueChange={(value) => onChangeRole(value as OrcaOrgRole)}
    >
      <SelectTrigger
        size="sm"
        className="w-28"
        aria-label={translate('auto.components.orca.profiles.org.members.role.label', 'Role')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ORG_ROLE_OPTIONS.map((role) => (
          <SelectItem key={role} value={role}>
            {orgRoleLabel(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : (
    <span className="text-xs font-medium text-muted-foreground">{orgRoleLabel(member.role)}</span>
  )

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground"
        aria-hidden
      >
        {orgMemberInitials(member.displayName, member.email)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">{displayName}</div>
        <div className="truncate text-[11px] text-muted-foreground">{member.email}</div>
      </div>

      {neverSignedIn && canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('cursor-default')}>{roleControl}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {translate(
              'auto.components.orca.profiles.org.members.not.signed.in',
              "They haven't signed in to Orca yet."
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        roleControl
      )}

      {canManage ? (
        confirmingRemove && !actionsDisabled ? (
          <div className="flex items-center gap-1">
            <Button
              variant="destructive"
              size="xs"
              onClick={() => {
                setConfirmingRemove(false)
                onRemove()
              }}
            >
              {translate('auto.components.orca.profiles.org.members.remove.confirm', 'Remove')}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmingRemove(false)}>
              {translate('auto.components.orca.profiles.org.members.remove.cancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={actionsDisabled}
            onClick={() => setConfirmingRemove(true)}
            aria-label={translate(
              'auto.components.orca.profiles.org.members.remove.label',
              'Remove teammate'
            )}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UserMinus className="size-3.5" />
            )}
          </Button>
        )
      ) : null}
    </div>
  )
}
