import { useState } from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaProfileOrgMemberMutationResult } from '../../../../../shared/orca-profiles'
import { useOrcaBillingStatus } from '../use-orca-billing-status'
import { TeamMembersView } from './TeamMembersView'
import { mutationFailureCopy } from './team-roles'
import { useOrgRoster } from './use-org-roster'

/**
 * Team members for the active org: list, invite by email (accepted at Orca's sign-in provider),
 * change roles, remove. Membership lives in Orca Cloud auth; Team seats follow it automatically
 * (auth pushes removals, billing re-reads the count), so nothing here touches Stripe.
 */
export function TeamMembersSection({
  orgId,
  viewerUserId
}: {
  orgId: string
  viewerUserId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const roster = useOrgRoster(orgId)
  const billing = useOrcaBillingStatus(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (
    action: () => Promise<OrcaProfileOrgMemberMutationResult>,
    success: string
  ): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await action().catch((error: unknown): OrcaProfileOrgMemberMutationResult => ({
      status: 'failed',
      error: String(error)
    }))
    setBusy(false)
    setNotice(outcome.status === 'ok' ? success : mutationFailureCopy(outcome, t))
    if (outcome.status === 'ok') {
      roster.refresh()
      billing.refresh()
    }
  }

  const entitlement = billing.result?.status === 'ok' ? billing.result.entitlement : null
  const billedSeats = entitlement && entitlement.plan !== null ? entitlement.seats : null

  return (
    <TeamMembersView
      result={roster.result}
      loading={roster.loading}
      busy={busy}
      notice={notice}
      billedSeats={billedSeats}
      seatChange={entitlement?.seatChange ?? null}
      viewerUserId={viewerUserId}
      onRefresh={() => {
        roster.refresh()
        billing.refresh()
      }}
      onInvite={(email, role) =>
        void run(
          () => window.api.orcaProfiles.orgMemberInvite({ orgId, email, role }),
          t(
            'auto.components.billing.team.invited',
            'Invite sent to {{value0}}. They join (and become a billed seat) when they accept.',
            { value0: email }
          )
        )
      }
      onRevoke={(email) =>
        void run(
          () => window.api.orcaProfiles.orgInviteRevoke({ orgId, email }),
          t('auto.components.billing.team.revoked', 'Invite revoked.')
        )
      }
      onChangeRole={(member, role) => {
        if (member.userId) {
          const userId = member.userId
          void run(
            () => window.api.orcaProfiles.orgMemberChangeRole({ orgId, userId, role }),
            t('auto.components.billing.team.roleChanged', 'Role updated.')
          )
        }
      }}
      onRemove={(member) => {
        const userId = member.userId
        if (!userId) {
          return
        }
        void confirm({
          title: t('auto.components.billing.team.removeTitle', 'Remove {{value0}}?', {
            value0: member.displayName ?? member.email
          }),
          description: t(
            'auto.components.billing.team.removeDescription2',
            'They lose access to the org right away. Their seat stays paid until your plan renews, then drops off.'
          ),
          confirmLabel: t('auto.components.billing.team.removeConfirm', 'Remove member'),
          confirmVariant: 'destructive'
        }).then((accepted) => {
          if (accepted) {
            void run(
              () => window.api.orcaProfiles.orgMemberRemove({ orgId, userId }),
              t('auto.components.billing.team.removed', 'Member removed.')
            )
          }
        })
      }}
    />
  )
}
