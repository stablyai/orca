import { Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { mfaDeadlineDate } from './team-mfa-copy'

export type TeamMfaBlockedScreenProps = {
  teamName: string
  enforceAt: number
  setupUrl: string
  /** A re-check is running (after "I've set it up", or on returning from the browser). */
  checking: boolean
  /** The last re-check still found no MFA. */
  stillMissing: boolean
  onSetUp: () => void
  onRecheck: () => void
  /** Switch to the personal account, which the team's policy does not affect. */
  onUsePersonal?: () => void
}

/**
 * In place of a team's content once its MFA deadline has passed for a member without MFA: what
 * happened, the one thing to do, and a way to keep working outside the team meanwhile.
 */
export function TeamMfaBlockedScreen({
  teamName,
  enforceAt,
  setupUrl,
  checking,
  stillMissing,
  onSetUp,
  onRecheck,
  onUsePersonal
}: TeamMfaBlockedScreenProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-foreground">
        <ShieldAlert className="size-5" />
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-medium">
          {t(
            'auto.components.teamMfa.blockedTitle',
            'Set up two-factor authentication to use {{value0}}',
            { value0: teamName }
          )}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {t(
            'auto.components.teamMfa.blockedBody',
            '{{value0}} has required it for all members since {{value1}}. Your workspaces and files are safe, and open again as soon as you add an authenticator app.',
            { value0: teamName, value1: mfaDeadlineDate(enforceAt, locale) }
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <OpenExternalSplitButton size="sm" link={setupUrl} onClick={onSetUp}>
          {t('auto.components.teamMfa.setUp', 'Set up MFA')}
        </OpenExternalSplitButton>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // Not disabled while checking: that would drop keyboard focus. A second press waits.
          aria-disabled={checking || undefined}
          onClick={() => {
            if (!checking) {
              onRecheck()
            }
          }}
        >
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('auto.components.teamMfa.recheck', 'I’ve set it up')}
        </Button>
      </div>
      <p className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {stillMissing && !checking
          ? t(
              'auto.components.teamMfa.stillMissing',
              'Your account still has no two-factor authentication. Finish the setup in your browser, then try again.'
            )
          : null}
      </p>
      {onUsePersonal ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="text-muted-foreground underline"
          onClick={onUsePersonal}
        >
          {t('auto.components.teamMfa.usePersonal', 'Use my personal account for now')}
        </Button>
      ) : null}
    </div>
  )
}
