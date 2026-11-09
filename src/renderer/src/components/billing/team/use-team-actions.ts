// Team mutations with optimistic rows: the change shows at once, the row shows a spinner while
// auth confirms, and a failure rolls back with the reason on that row (design review M11/M12).
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type {
  OrcaOrgMember,
  OrcaOrgMembersRoster,
  OrcaOrgRole,
  OrcaProfileOrgMemberMutationResult
} from '../../../../../shared/orca-profiles'
import type { InviteBatchOutcome } from './TeamInviteComposer'
import type { TeamRowState } from './TeamMemberList'
import { mutationFailureCopy } from './team-copy'
import { roleLabel } from './team-roles'

type Overlay = (roster: OrcaOrgMembersRoster) => OrcaOrgMembersRoster

const memberKey = (member: OrcaOrgMember): string =>
  `member:${member.userId ?? member.email.toLowerCase()}`
const inviteKey = (email: string): string => `invite:${email.toLowerCase()}`

async function settle(
  call: () => Promise<OrcaProfileOrgMemberMutationResult>
): Promise<OrcaProfileOrgMemberMutationResult> {
  return call().catch((error: unknown) => ({ status: 'failed' as const, error: String(error) }))
}

export function useTeamActions({
  orgId,
  onChanged
}: {
  orgId: string
  /** Re-read roster and billing quietly after a confirmed change. */
  onChanged: () => void
}) {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const api = window.api.orcaProfiles
  const [overlays, setOverlays] = useState<{ id: number; apply: Overlay }[]>([])
  const [rowStates, setRowStates] = useState<Record<string, TeamRowState>>({})

  const setRow = useCallback((key: string, state: TeamRowState | null) => {
    setRowStates(({ [key]: _old, ...rest }) => (state ? { ...rest, [key]: state } : rest))
  }, [])

  /** Applies `overlay` now, runs `call`, and keeps or rolls back the overlay by the outcome. */
  const optimistic = useCallback(
    async (
      key: string,
      overlay: Overlay | null,
      call: () => Promise<OrcaProfileOrgMemberMutationResult>
    ): Promise<OrcaProfileOrgMemberMutationResult> => {
      const id = Math.random()
      if (overlay) {
        setOverlays((list) => [...list, { id, apply: overlay }])
      }
      setRow(key, { busy: true })
      const outcome = await settle(call)
      if (outcome.status === 'ok') {
        setRow(key, null)
        onChanged()
        // The refreshed roster carries the change; drop the overlay once it has had time to land.
        window.setTimeout(
          () => setOverlays((list) => list.filter((entry) => entry.id !== id)),
          4_000
        )
      } else {
        setOverlays((list) => list.filter((entry) => entry.id !== id))
        setRow(key, { error: mutationFailureCopy(outcome, t) ?? undefined })
      }
      return outcome
    },
    [onChanged, setRow, t]
  )

  const applyOverlays = useCallback(
    (roster: OrcaOrgMembersRoster): OrcaOrgMembersRoster =>
      overlays.reduce((current, overlay) => overlay.apply(current), roster),
    [overlays]
  )

  const changeRole = (member: OrcaOrgMember, role: OrcaOrgRole, undoable = true): void => {
    const userId = member.userId
    if (!userId) {
      return
    }
    const previous = member.role
    void optimistic(
      memberKey(member),
      (roster) => ({
        ...roster,
        members: roster.members.map((m) => (m.userId === userId ? { ...m, role } : m))
      }),
      () => api.orgMemberChangeRole({ orgId, userId, role })
    ).then((outcome) => {
      if (outcome.status === 'ok' && undoable) {
        toast.success(
          t('auto.components.billing.team.roleToast', '{{value0}} is now {{value1}}', {
            value0: member.displayName ?? member.email,
            value1: roleLabel(role, t).toLowerCase()
          }),
          {
            action: {
              label: t('auto.components.billing.team.undo', 'Undo'),
              onClick: () => changeRole({ ...member, role }, previous, false)
            }
          }
        )
      }
    })
  }

  const invite = async (emails: string[], role: OrcaOrgRole): Promise<InviteBatchOutcome> => {
    const now = Date.now()
    const failed: InviteBatchOutcome['failed'] = []
    // Sequential: auth rate-limits member changes per actor, and order keeps errors readable.
    for (const email of emails) {
      const outcome = await optimistic(
        inviteKey(email),
        (roster) =>
          roster.pendingInvites.some((i) => i.email.toLowerCase() === email.toLowerCase())
            ? roster
            : {
                ...roster,
                pendingInvites: [...roster.pendingInvites, { email, role, createdAt: now }]
              },
        () => api.orgMemberInvite({ orgId, email, role })
      )
      if (outcome.status !== 'ok') {
        setRow(inviteKey(email), null)
        failed.push({ email, message: mutationFailureCopy(outcome, t) ?? '' })
        if (outcome.status === 'rate-limited') {
          for (const rest of emails.slice(emails.indexOf(email) + 1)) {
            failed.push({ email: rest, message: mutationFailureCopy(outcome, t) ?? '' })
          }
          break
        }
      }
    }
    const sent = emails.length - failed.length
    if (sent > 0) {
      toast.success(
        sent === 1
          ? t('auto.components.billing.team.inviteSentOne', 'Invite sent to {{value0}}', {
              value0: emails.find((email) => !failed.some((f) => f.email === email)) ?? ''
            })
          : t('auto.components.billing.team.inviteSentMany', '{{value0}} invites sent', {
              value0: String(sent)
            }),
        {
          description: t(
            'auto.components.billing.team.inviteSentBody',
            'They join, and take a seat, when they accept.'
          )
        }
      )
    }
    return { failed }
  }

  const revoke = (email: string, role: OrcaOrgRole): void => {
    void optimistic(
      inviteKey(email),
      (roster) => ({
        ...roster,
        pendingInvites: roster.pendingInvites.filter(
          (i) => i.email.toLowerCase() !== email.toLowerCase()
        )
      }),
      () => api.orgInviteRevoke({ orgId, email })
    ).then((outcome) => {
      if (outcome.status === 'ok') {
        toast.success(
          t('auto.components.billing.team.revokedToast', 'Invite to {{value0}} revoked', {
            value0: email
          }),
          {
            action: {
              label: t('auto.components.billing.team.undo', 'Undo'),
              onClick: () => void invite([email], role)
            }
          }
        )
      }
    })
  }

  const resend = (email: string, role: OrcaOrgRole): void => {
    void optimistic(inviteKey(email), null, () => api.orgInviteResend({ orgId, email, role })).then(
      (outcome) => {
        if (outcome.status === 'ok') {
          toast.success(
            t('auto.components.billing.team.resentToast', 'New invite sent to {{value0}}', {
              value0: email
            })
          )
        }
      }
    )
  }

  const remove = (member: OrcaOrgMember): void => {
    const userId = member.userId
    if (!userId) {
      return
    }
    const name = member.displayName ?? member.email
    void confirm({
      title: t('auto.components.billing.team.removeTitle', 'Remove {{value0}}?', { value0: name }),
      description: t(
        'auto.components.billing.team.removeDescription3',
        '{{value0}} loses access to the team’s cloud workspaces and secrets right away. Their seat stays paid until your plan renews, and inviting them back before then is free.',
        { value0: name }
      ),
      confirmLabel: t('auto.components.billing.team.removeConfirm', 'Remove member'),
      confirmVariant: 'destructive'
    }).then((accepted) => {
      if (!accepted) {
        return
      }
      void optimistic(
        memberKey(member),
        (roster) => ({ ...roster, members: roster.members.filter((m) => m.userId !== userId) }),
        () => api.orgMemberRemove({ orgId, userId })
      ).then((outcome) => {
        if (outcome.status === 'ok') {
          toast.success(
            t('auto.components.billing.team.removedToast', '{{value0}} removed', { value0: name })
          )
        }
      })
    })
  }

  const makeOwner = (member: OrcaOrgMember): void => {
    const name = member.displayName ?? member.email
    void confirm({
      title: t('auto.components.billing.team.makeOwnerTitle', 'Make {{value0}} an owner?', {
        value0: name
      }),
      description: t(
        'auto.components.billing.team.makeOwnerBody',
        'Owners control billing and can manage other owners. To hand the team over, make {{value0}} an owner, then ask them to change your role.',
        { value0: name }
      ),
      confirmLabel: t('auto.components.billing.team.makeOwnerConfirm', 'Make owner')
    }).then((accepted) => {
      if (accepted) {
        changeRole(member, 'owner')
      }
    })
  }

  return { rowStates, applyOverlays, changeRole, invite, revoke, resend, remove, makeOwner }
}
