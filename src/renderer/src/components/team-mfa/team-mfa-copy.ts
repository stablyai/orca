// Copy and small rules shared by the MFA banner, the blocked screen and the Enterprise row. Pure,
// so the views and their tests agree on every boundary.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaTeamMfaGrace, OrcaTeamMfaPolicy } from '../../../../shared/orca-team-mfa-policy'

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days left, rounded up; 0 once the deadline has passed. Matches the server and the emails. */
export function mfaDaysLeft(enforceAt: number, now: number): number {
  return Math.max(0, Math.ceil((enforceAt - now) / DAY_MS))
}

/**
 * What the person should see for this team:
 * - `banner`: the team requires MFA, they have none, and there is still time.
 * - `blocked`: the deadline passed; the team is closed to them until they set it up.
 * - `none`: nothing to show (no policy, they have MFA, or their state is unknown).
 * Only the server's `blocked` blocks: the desktop never decides that from the clock.
 */
export function teamMfaSurface(policy: OrcaTeamMfaPolicy | null): 'none' | 'banner' | 'blocked' {
  if (!policy?.policy) {
    return 'none'
  }
  if (policy.self === 'blocked') {
    return 'blocked'
  }
  return policy.self === 'pending' ? 'banner' : 'none'
}

/** From this many days before the deadline the notice stops being quiet (design-squad). */
export const MFA_URGENT_DAYS = 3

/**
 * How loud the notice is: quiet with more than three days left, a warning in the last three,
 * and blocked only on the server's word (never from the clock).
 */
export type TeamMfaUrgency = 'quiet' | 'soon' | 'blocked'

export function mfaUrgency(enforceAt: number, now: number, blocked: boolean): TeamMfaUrgency {
  if (blocked) {
    return 'blocked'
  }
  return mfaDaysLeft(enforceAt, now) <= MFA_URGENT_DAYS ? 'soon' : 'quiet'
}

/** "Acme requires MFA in 2 days": the title once the deadline is close. */
export function mfaSoonTitle(
  teamName: string,
  enforceAt: number,
  now: number,
  t: Translate
): string {
  const days = mfaDaysLeft(enforceAt, now)
  if (days <= 0) {
    return t('auto.components.teamMfa.soonTitleNow', '{{value0}} requires MFA now', {
      value0: teamName
    })
  }
  return t('auto.components.teamMfa.soonTitle', '{{value0}} requires MFA in {{count}} days', {
    value0: teamName,
    count: days,
    defaultValue_one: '{{value0}} requires MFA in {{count}} day'
  })
}

/**
 * The one-time toast is shown once per team and deadline, so a changed date announces itself
 * again and a restart does not repeat it.
 */
export function mfaToastSeenKey(orgId: string, enforceAt: number): string {
  return `orca.teamMfa.toastSeen:${orgId}:${enforceAt}`
}

/** True the first time for a deadline; records it. A storage failure shows it rather than hide it. */
export function claimMfaToast(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  orgId: string,
  enforceAt: number
): boolean {
  const key = mfaToastSeenKey(orgId, enforceAt)
  try {
    if (storage?.getItem(key) === '1') {
      return false
    }
    storage?.setItem(key, '1')
  } catch {
    // Private mode or a full quota: showing it again next launch is the lesser problem.
  }
  return true
}

/** "6 days left", "1 day left", "Due now". i18next plurals, never ternaries on the count. */
export function mfaCountdownLabel(enforceAt: number, now: number, t: Translate): string {
  const days = mfaDaysLeft(enforceAt, now)
  if (days <= 0) {
    return t('auto.components.teamMfa.dueNow', 'Due now')
  }
  return t('auto.components.teamMfa.daysLeft', '{{count}} days left', {
    count: days,
    defaultValue_one: '{{count}} day left'
  })
}

export function mfaDeadlineDate(enforceAt: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric' }).format(
    enforceAt
  )
}

export function mfaGraceLabel(grace: OrcaTeamMfaGrace, t: Translate): string {
  switch (grace) {
    case 'now':
      return t('auto.components.teamMfa.graceNow', 'Immediately')
    case 7:
      return t('auto.components.teamMfa.grace7', 'In 7 days')
    case 14:
      return t('auto.components.teamMfa.grace14', 'In 14 days')
    case 30:
      return t('auto.components.teamMfa.grace30', 'In 30 days')
  }
}
