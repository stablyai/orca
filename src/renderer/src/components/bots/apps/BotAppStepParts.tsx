// The pieces every Add to <bot> step is drawn from: its header, a form's heading, and the centred
// outcome screens (finish in your browser, couldn't sign in, added).
import React from 'react'
import { Check, ChevronLeft, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

/** Back to the list (or the step before), and Close. */
export function BotAppStepHeader({
  backLabel,
  onBack,
  onClose
}: {
  backLabel?: string
  /** None on a finished step: there is nothing to go back to. */
  onBack?: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2 px-3 pt-3">
      {onBack ? (
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ChevronLeft className="size-3.5" />
          {backLabel ?? t('bots.apps.back', 'Back')}
        </Button>
      ) : null}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('bots.apps.close', 'Close')}
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

/** A form step's heading: the app's mark, its title and a line under it. */
export function BotAppStepHeading({
  logo,
  title,
  line
}: {
  logo: React.ReactNode
  title: string
  line: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-1 mb-4.5 flex items-center gap-3">
      {logo}
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold" title={title}>
          {title}
        </p>
        <p className="mt-0.5 text-sm leading-[18px] break-words text-muted-foreground">{line}</p>
      </div>
    </div>
  )
}

/** The badge on a logo: a check once added (green on a list row, where most rows have none), a cross
 *  when sign-in failed, a spinner while waiting. `sm` sits on a list row's tile. */
export function BotAppLogoBadge({
  kind,
  size = 'md'
}: {
  kind: 'done' | 'added' | 'failed' | 'waiting'
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const sm = size === 'sm'
  return (
    <span
      className={cn(
        'absolute flex items-center justify-center rounded-full bg-popover',
        sm
          ? '-right-1 -bottom-1 size-4 ring-2 ring-dialog-surface'
          : '-right-1.5 -bottom-1.5 size-5'
      )}
    >
      {kind === 'waiting' ? (
        <LoaderCircle className={cn('animate-spin text-foreground', sm ? 'size-3' : 'size-3.5')} />
      ) : (
        <span
          className={cn(
            'flex items-center justify-center rounded-full text-background',
            kind === 'added' ? 'bg-status-success' : 'bg-foreground',
            'size-4'
          )}
        >
          {kind === 'done' || kind === 'added' ? (
            <Check className={sm ? 'size-2.25' : 'size-2.5'} strokeWidth={3} />
          ) : (
            <X className={sm ? 'size-2.25' : 'size-2.5'} strokeWidth={3} />
          )}
        </span>
      )}
    </span>
  )
}

/** A centred outcome: the app's mark, what happened, what to do, and its buttons. */
export function BotAppOutcome({
  logo,
  badge,
  title,
  line,
  actions,
  footer
}: {
  logo: React.ReactNode
  badge?: 'done' | 'failed'
  title: string
  line: React.ReactNode
  actions: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center px-6 pt-3 pb-6 text-center">
      <span className="relative">
        {logo}
        {badge ? <BotAppLogoBadge kind={badge} /> : null}
      </span>
      <p className="mt-3.5 max-w-full truncate text-[15px] font-semibold" title={title}>
        {title}
      </p>
      <div className="mt-1.5 max-w-85 text-sm break-words text-muted-foreground">{line}</div>
      <div className="mt-4.5 flex items-center justify-center gap-2">{actions}</div>
      {footer ? <div className="mt-3.5 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  )
}

/** Finish in your browser: a sign-in under way in the default browser; Close leaves it running. */
export function BotAppBrowserWait({
  logo,
  line,
  onClose,
  onOpenAgain,
  footer
}: {
  logo: React.ReactNode
  line: string
  onClose: () => void
  /** None until the sign-in page's address is known. */
  onOpenAgain?: () => void
  footer?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <BotAppOutcome
      logo={logo}
      title={t('bots.connectors.finishInBrowser', 'Finish in your browser')}
      line={
        <span className="inline-flex items-center gap-1.5">
          <LoaderCircle className="size-3.5 animate-spin" />
          {line}
        </span>
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            title={t('bots.apps.closeKeepsSigningIn', 'Sign-in continues in your browser')}
            onClick={onClose}
          >
            {t('bots.apps.close', 'Close')}
          </Button>
          <Button variant="outline" size="sm" disabled={!onOpenAgain} onClick={onOpenAgain}>
            <ExternalLink />
            {t('bots.apps.openPageAgain', 'Open page again')}
          </Button>
        </>
      }
      footer={footer}
    />
  )
}
