import { InlineError } from '@/components/ui/inline-error'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { mfaCountdownLabel, mfaDeadlineDate } from './team-mfa-copy'

export type TeamMfaBannerProps = {
  teamName: string
  /** Epoch ms from which the team is closed to members without MFA. */
  enforceAt: number
  now: number
  setupUrl: string
  onSetUp: () => void
}

/**
 * Shown to a member whose team requires MFA and who has none yet, until the deadline: how long
 * is left and the way to set it up. After the deadline the blocked screen takes over.
 */
export function TeamMfaBanner({
  teamName,
  enforceAt,
  now,
  setupUrl,
  onSetUp
}: TeamMfaBannerProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  return (
    <InlineError
      tone="neutral"
      title={t(
        'auto.components.teamMfa.bannerTitle',
        '{{value0}} requires two-factor authentication. {{value1}}.',
        { value0: teamName, value1: mfaCountdownLabel(enforceAt, now, t) }
      )}
      detail={t(
        'auto.components.teamMfa.bannerBody',
        'Set it up by {{value0}}. After that you can’t use this team’s workspaces until you do.',
        { value0: mfaDeadlineDate(enforceAt, locale) }
      )}
      action={
        <OpenExternalSplitButton variant="outline" size="xs" link={setupUrl} onClick={onSetUp}>
          {t('auto.components.teamMfa.setUp', 'Set up MFA')}
        </OpenExternalSplitButton>
      }
    />
  )
}
