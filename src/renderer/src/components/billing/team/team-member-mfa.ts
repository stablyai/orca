// The MFA column of the team list: who sees it and what each cell says. Pure, so the view and its
// tests share it.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaOrgMember, OrcaOrgRole } from '../../../../../shared/orca-profiles'
import type { TeamRow } from './team-roster-rows'

/**
 * Owners and admins only. The server already leaves the status out for everyone else; the role
 * check keeps the column hidden even if a roster carrying it ever reached a member's desktop.
 */
export function showMfaColumn(rows: readonly TeamRow[], viewerRole: OrcaOrgRole): boolean {
  return (
    (viewerRole === 'owner' || viewerRole === 'admin') &&
    rows.some((row) => row.kind === 'member' && row.member.mfa !== undefined)
  )
}

/** Null when the provider said nothing about this member: shown as blank, never as "off". */
export function memberMfaLabel(
  member: Pick<OrcaOrgMember, 'mfa' | 'mfaDeadline'>,
  locale: string,
  t: Translate
): string | null {
  switch (member.mfa) {
    case 'on':
      return t('auto.components.billing.team.mfaOn', 'MFA on')
    case 'off':
      return t('auto.components.billing.team.mfaOff', 'MFA off')
    case 'pending':
      return member.mfaDeadline === undefined
        ? t('auto.components.billing.team.mfaPending', 'MFA pending')
        : t('auto.components.billing.team.mfaPendingBy', 'MFA due {{value0}}', {
            value0: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
              member.mfaDeadline
            )
          })
    case undefined:
      return null
  }
}
