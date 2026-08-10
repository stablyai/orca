import { useCallback, useEffect, useState } from 'react'
import { Loader2, Mail, RefreshCw, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type {
  OrcaOrgMember,
  OrcaOrgMembersRoster,
  OrcaOrgRole,
  OrcaProfileOrgMemberMutationResult
} from '../../../../shared/orca-profiles'
import { OrcaProfileOrgMemberRow } from './OrcaProfileOrgMemberRow'
import {
  describeOrgMutationError,
  ORG_ROLE_OPTIONS,
  orgRoleLabel
} from './orca-profile-org-members-labels'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  orgName?: string
  viewerUserId?: string
}

function isOk(result: OrcaProfileOrgMemberMutationResult): result is { status: 'ok' } {
  return result.status === 'ok'
}

export function OrcaProfileOrgMembersDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  viewerUserId
}: DialogProps): React.JSX.Element {
  const [roster, setRoster] = useState<OrcaOrgMembersRoster | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null)
  const [pendingInviteEmail, setPendingInviteEmail] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrcaOrgRole>('member')
  const [inviting, setInviting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(false)
    setActionError(null)
    const result = await window.api.orcaProfiles.orgMembersList({ orgId })
    if (result.status === 'ok') {
      setRoster(result.roster)
    } else {
      setRoster(null)
      setLoadError(true)
    }
    setLoading(false)
  }, [orgId])

  // Why: reload every time the dialog opens so a manager always acts on the
  // current roster, and clear transient dialog state when it closes.
  useEffect(() => {
    if (open) {
      void refresh()
    } else {
      setActionError(null)
      setInviteEmail('')
      setInviteRole('member')
    }
  }, [open, refresh])

  const canManage = roster?.canManageMembers === true

  const runMutation = async (
    mutation: Promise<OrcaProfileOrgMemberMutationResult>
  ): Promise<boolean> => {
    setActionError(null)
    const result = await mutation
    if (isOk(result)) {
      await refresh()
      return true
    }
    setActionError(describeOrgMutationError(result))
    return false
  }

  const handleChangeRole = async (member: OrcaOrgMember, role: OrcaOrgRole): Promise<void> => {
    if (member.userId === null || role === member.role) {
      return
    }
    setPendingMemberId(member.userId)
    await runMutation(
      window.api.orcaProfiles.orgMemberChangeRole({ orgId, userId: member.userId, role })
    )
    setPendingMemberId(null)
  }

  const handleRemove = async (member: OrcaOrgMember): Promise<void> => {
    if (member.userId === null) {
      return
    }
    setPendingMemberId(member.userId)
    await runMutation(window.api.orcaProfiles.orgMemberRemove({ orgId, userId: member.userId }))
    setPendingMemberId(null)
  }

  const handleRevoke = async (email: string): Promise<void> => {
    setPendingInviteEmail(email)
    await runMutation(window.api.orcaProfiles.orgInviteRevoke({ orgId, email }))
    setPendingInviteEmail(null)
  }

  const handleInvite = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const email = inviteEmail.trim()
    if (!email || inviting) {
      return
    }
    setInviting(true)
    const ok = await runMutation(
      window.api.orcaProfiles.orgMemberInvite({ orgId, email, role: inviteRole })
    )
    setInviting(false)
    if (ok) {
      setInviteEmail('')
      setInviteRole('member')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            {translate('auto.components.orca.profiles.org.members.title', 'Organization members')}
          </DialogTitle>
          <DialogDescription>
            {orgName
              ? translate(
                  'auto.components.orca.profiles.org.members.subtitle.named',
                  'People in {{orgName}} who can collaborate on Orca.',
                  { orgName }
                )
              : translate(
                  'auto.components.orca.profiles.org.members.subtitle.default',
                  'People in your organization who can collaborate on Orca.'
                )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.orca.profiles.org.members.load.error',
                "Couldn't load organization members."
              )}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
              {translate('auto.components.orca.profiles.org.members.retry', 'Try again')}
            </Button>
          </div>
        ) : roster ? (
          <div className="flex flex-col gap-4">
            {actionError ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {actionError}
              </p>
            ) : null}

            <ScrollArea className="max-h-[280px] pr-2">
              <div className="divide-y divide-border/60">
                {roster.members.map((member) => (
                  <OrcaProfileOrgMemberRow
                    key={member.userId ?? member.email}
                    member={member}
                    canManage={canManage}
                    isSelf={member.userId !== null && member.userId === viewerUserId}
                    busy={pendingMemberId === member.userId}
                    onChangeRole={(role) => void handleChangeRole(member, role)}
                    onRemove={() => void handleRemove(member)}
                  />
                ))}
              </div>
            </ScrollArea>

            {canManage && roster.pendingInvites.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {translate(
                    'auto.components.orca.profiles.org.members.pending.title',
                    'Pending invites'
                  )}
                </p>
                {roster.pendingInvites.map((invite) => (
                  <div key={invite.email} className="flex items-center gap-2.5 py-1">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {invite.email}
                    </span>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {orgRoleLabel(invite.role)}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pendingInviteEmail === invite.email}
                      onClick={() => void handleRevoke(invite.email)}
                    >
                      {pendingInviteEmail === invite.email ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : null}
                      {translate(
                        'auto.components.orca.profiles.org.members.pending.revoke',
                        'Revoke'
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {canManage ? (
              <form onSubmit={(event) => void handleInvite(event)} className="flex items-end gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label
                    htmlFor="orca-org-invite-email"
                    className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {translate('auto.components.orca.profiles.org.members.invite.title', 'Invite')}
                  </label>
                  <Input
                    id="orca-org-invite-email"
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    disabled={inviting}
                    placeholder={translate(
                      'auto.components.orca.profiles.org.members.invite.placeholder',
                      'teammate@example.com'
                    )}
                  />
                </div>
                <Select
                  value={inviteRole}
                  disabled={inviting}
                  onValueChange={(value) => setInviteRole(value as OrcaOrgRole)}
                >
                  <SelectTrigger
                    className="w-28"
                    aria-label={translate(
                      'auto.components.orca.profiles.org.members.invite.role',
                      'Invite role'
                    )}
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
                <Button type="submit" size="sm" disabled={inviting || !inviteEmail.trim()}>
                  {inviting ? <Loader2 className="size-4 animate-spin" /> : null}
                  {translate('auto.components.orca.profiles.org.members.invite.submit', 'Send')}
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
