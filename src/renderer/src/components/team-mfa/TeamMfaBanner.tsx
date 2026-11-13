import { ShieldAlert } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { cn } from '@/lib/class-names'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { BANNER_BODY_TEXT, BANNER_TONE } from '@/components/ui/banner-tone'
import { mfaCountdownLabel, mfaDeadlineDate, mfaSoonTitle, mfaUrgency } from './team-mfa-copy'

export type TeamMfaBannerProps = {
  teamName: string
  /** Epoch ms from which the team is closed to members without MFA. */
  enforceAt: number
  now: number
  setupUrl: string
  onSetUp: () => void
  /** The deadline has passed and the team is closed to this person until they set MFA up. */
  blocked?: boolean
  /** `sidebar`: the narrow stacked layout of the sidebar's banner stack. */
  variant?: 'inline' | 'sidebar'
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
  variant = 'inline',
  className
}: TeamMfaBannerProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const urgency = mfaUrgency(enforceAt, now, blocked)
  const title =
    urgency === 'soon'
      ? mfaSoonTitle(teamName, enforceAt, now, t)
      : blocked
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
  const detail = blocked
    ? t(
        'auto.components.teamMfa.bannerBlockedBody',
        'You can’t use this team’s workspaces until you set it up. Your personal account isn’t affected.'
      )
    : t(
        'auto.components.teamMfa.bannerBody',
        'Set it up by {{value0}}. After that you can’t use this team’s workspaces until you do.',
        { value0: mfaDeadlineDate(enforceAt, locale) }
      )
  const action = (
    <OpenExternalSplitButton variant="outline" size="xs" link={setupUrl} onClick={onSetUp}>
      {t('auto.components.teamMfa.setUp', 'Set up MFA')}
    </OpenExternalSplitButton>
  )
  if (variant === 'sidebar') {
    // Same shape as the other banners in the sidebar stack (StalledTerminalDaemonBanner): the
    // column is narrow, so the action sits under the text.
    return (
      <section
        role={blocked ? 'alert' : 'status'}
        data-team-mfa-banner={urgency}
        className={cn(
          'mx-2 mb-2 shrink-0 rounded-md border p-2.5 text-worktree-sidebar-foreground',
          // Quiet with time to spare; the shared warning look in the last three days; the
          // destructive border of a real block after the deadline.
          urgency === 'soon'
            ? cn(BANNER_TONE.warning.surface, BANNER_TONE.warning.border)
            : 'bg-worktree-sidebar-accent/40',
          urgency === 'blocked' && 'border-destructive/50',
          urgency === 'quiet' && 'border-border',
          className
        )}
      >
        <div className="flex items-start gap-2">
          <ShieldAlert
            className={cn(
              'mt-px size-3.5 shrink-0',
              urgency === 'blocked'
                ? 'text-destructive'
                : urgency === 'soon'
                  ? BANNER_TONE.warning.icon
                  : 'text-muted-foreground'
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-semibold leading-snug">{title}</p>
            <p
              className={cn(
                'text-xs leading-snug',
                urgency === 'soon' ? BANNER_BODY_TEXT : 'text-muted-foreground'
              )}
            >
              {detail}
            </p>
            {action}
          </div>
        </div>
      </section>
    )
  }
  return (
    <InlineError
      className={className}
      tone={blocked ? 'error' : 'neutral'}
      title={title}
      detail={detail}
      action={action}
    />
  )
}
