// "Two-factor authentication" in Settings, Enterprise: the team's Require two-factor policy, wired
// to the account. The pane renders it only for a team's owners and admins; the server refuses
// everyone else regardless.
import { useCallback, useEffect, useState } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  OrcaTeamMfaGrace,
  OrcaTeamMfaPendingMember,
  OrcaTeamMfaPolicy
} from '../../../../shared/orca-team-mfa-policy'
import {
  EnterpriseUpsell,
  EnterpriseUpsellLine,
  type EnterpriseContact
} from '../settings/enterprise/EnterpriseUpsell'
import { SettingsGroup } from '../settings/section-layout/SettingsGroup'
import { RequireMfaRow, type RequireMfaRowNotice, type RequireMfaRowProps } from './RequireMfaRow'
import { useTeamMfaPolicy } from './use-team-mfa-policy'

type ChangeStatus =
  | 'actor-needs-mfa'
  | 'not-entitled'
  | 'sso-needs-notice'
  | 'rate-limited'
  | 'forbidden'
  | 'other'

/** Why a change did not go through, in the person's terms. Exported for tests. */
export function mfaChangeError(status: ChangeStatus, t: Translate): string {
  switch (status) {
    case 'actor-needs-mfa':
      return t(
        'auto.components.teamMfa.errorActorNeedsMfa',
        'Set up two-factor authentication on your own account first.'
      )
    case 'not-entitled':
      return t('auto.components.teamMfa.errorNotEntitled', 'Your team’s plan doesn’t include this.')
    case 'sso-needs-notice':
      return t(
        'auto.components.teamMfa.errorSsoNotice',
        'Your team uses single sign-on, so pick a date at least 7 days out. Members need time to sign in again.'
      )
    case 'rate-limited':
      return t(
        'auto.components.teamMfa.errorRateLimited',
        'Too many changes at once. Wait a minute and try again.'
      )
    case 'forbidden':
      return t('auto.components.teamMfa.errorForbidden', 'Only owners and admins can change this.')
    case 'other':
      return t('auto.components.teamMfa.errorOther', 'Couldn’t save the change. Try again.')
  }
}

export function EnterpriseMfaPolicy({
  orgId,
  contact,
  onContactSales,
  underBanner = false
}: {
  orgId: string
  contact: EnterpriseContact
  onContactSales: (url: string) => void
  underBanner?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { policy, refresh } = useTeamMfaPolicy(orgId)
  const [pending, setPending] = useState<OrcaTeamMfaPendingMember[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<RequireMfaRowNotice | null>(null)
  const [now] = useState(() => Date.now())
  const active = policy?.policy ?? null

  const loadPending = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.orcaProfiles.teamMfaPending({ orgId })
      setPending(result.status === 'ok' ? result.members : null)
    } catch {
      setPending(null)
    }
  }, [orgId])

  useEffect(() => {
    if (active) {
      void loadPending()
    } else {
      setPending(null)
    }
    // Reload when the deadline changes, not on every policy read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.enforceAt, loadPending])

  // Nothing until the first read answers, and nothing for a server without the policy API.
  if (!policy?.manage) {
    return null
  }

  const change = async (enforce: OrcaTeamMfaGrace | 'off'): Promise<void> => {
    setBusy(true)
    setNotice(null)
    let status: string
    try {
      status = (await window.api.orcaProfiles.teamMfaPolicySet({ orgId, enforce })).status
    } catch {
      status = 'failed'
    }
    setBusy(false)
    if (status === 'ok') {
      await refresh()
      return
    }
    const known: readonly ChangeStatus[] = [
      'actor-needs-mfa',
      'not-entitled',
      'sso-needs-notice',
      'rate-limited',
      'forbidden'
    ]
    setNotice({
      kind: 'error',
      message: mfaChangeError(known.find((candidate) => candidate === status) ?? 'other', t)
    })
  }

  const remind = async (userId?: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.orcaProfiles.teamMfaRemind({
        orgId,
        ...(userId ? { userId } : {})
      })
      setNotice(
        result.status === 'ok'
          ? {
              kind: 'reminded',
              recipients: result.recipients,
              // Only a server that says it emailed counts as sent.
              emailed: result.delivery === 'test-inbox'
            }
          : {
              kind: 'error',
              message: mfaChangeError(
                result.status === 'rate-limited' ? 'rate-limited' : 'other',
                t
              )
            }
      )
    } catch {
      setNotice({ kind: 'error', message: mfaChangeError('other', t) })
    }
    setBusy(false)
  }

  return (
    <EnterpriseMfaGroup
      policy={policy}
      manage={policy.manage}
      pending={pending}
      now={now}
      busy={busy}
      notice={notice}
      contact={contact}
      onRequire={(grace) => void change(grace)}
      onTurnOff={() => void change('off')}
      onRemind={(userId) => void remind(userId)}
      onSetUpOwn={() => void window.api.shell.openUrl(policy.setupUrl)}
      onContactSales={onContactSales}
      underBanner={underBanner}
    />
  )
}

export type EnterpriseMfaGroupProps = Omit<RequireMfaRowProps, 'policy'> & {
  policy: OrcaTeamMfaPolicy
  manage: NonNullable<OrcaTeamMfaPolicy['manage']>
  contact: EnterpriseContact
  onContactSales: (url: string) => void
  /** The page banner already carries Contact sales: the locked state is a plain line, no button. */
  underBanner?: boolean
}

/**
 * The "Two-factor authentication" group as shown: the Require two-factor row when the plan
 * includes it, the shared upsell when it does not, and the single sign-on note when the team's
 * identity provider handles members who sign in that way.
 */
export function EnterpriseMfaGroup({
  policy,
  manage,
  contact,
  onContactSales,
  underBanner = false,
  ...row
}: EnterpriseMfaGroupProps): React.JSX.Element {
  const t = useTranslate()
  const upsellBody = t(
    'auto.components.teamMfa.upsellBody',
    'Set a date after which members need two-factor authentication to use your team’s workspaces.'
  )
  return (
    <SettingsGroup
      title={t('auto.components.teamMfa.groupTitle', 'Two-factor authentication')}
      description={
        manage.ssoHandled
          ? t(
              'auto.components.teamMfa.groupSsoNote',
              'Members who sign in with single sign-on use your identity provider’s two-factor settings. This requirement applies only to members who sign in another way.'
            )
          : undefined
      }
    >
      {manage.available ? (
        // Padded like every other row in a settings card, so it does not sit on the card's edge.
        <div data-settings-row="" className="py-4">
          <RequireMfaRow policy={policy} {...row} />
        </div>
      ) : underBanner ? (
        <EnterpriseUpsellLine>{upsellBody}</EnterpriseUpsellLine>
      ) : (
        <EnterpriseUpsell
          title={t(
            'auto.components.teamMfa.upsellTitle',
            'Requiring two-factor authentication is part of {{value0}}',
            { value0: contact.planName }
          )}
          body={upsellBody}
          contact={contact}
          onContactSales={onContactSales}
        />
      )}
    </SettingsGroup>
  )
}
