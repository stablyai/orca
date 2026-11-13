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
  /** The deadline has passed and the team is closed to this person until they set MFA up. */
  blocked?: boolean
  className?: string
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
  onSetUp,
  blocked = false,
  className
}: TeamMfaBannerProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  return (
    <InlineError
      className={className}
      tone={blocked ? 'error' : 'neutral'}
      title={
        blocked
          ? t(
              'auto.components.teamMfa.bannerBlockedTitle',
              '{{value0}} requires two-factor authentication',
              { value0: teamName }
            )
          : t(
              'auto.components.teamMfa.bannerTitle',
              '{{value0}} requires two-factor authentication. {{value1}}.',
              { value0: teamName, value1: mfaCountdownLabel(enforceAt, now, t) }
            )
      }
      detail={
        blocked
          ? t(
              'auto.components.teamMfa.bannerBlockedBody',
              'You can’t use this team’s workspaces until you set it up. Your personal account is not affected.'
            )
          : t(
              'auto.components.teamMfa.bannerBody',
              'Set it up by {{value0}}. After that you can’t use this team’s workspaces until you do.',
              { value0: mfaDeadlineDate(enforceAt, locale) }
            )
      }
      action={
        <OpenExternalSplitButton variant="outline" size="xs" link={setupUrl} onClick={onSetUp}>
          {t('auto.components.teamMfa.setUp', 'Set up MFA')}
        </OpenExternalSplitButton>
      }
    />
  )
}
