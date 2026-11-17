import { useId } from 'react'
import { Trans } from 'react-i18next'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { LanguageOfferProgressLabel } from './LanguagePackDiscoverySummary'
import type { LanguageOfferSummary } from './device-language-offer'
import type { LanguageOfferProgress } from './use-language-offer-action'

/** One-time nudge that a community translation matches the device language. */
export function LanguagePackSuggestionToast({
  offer,
  progress = null,
  error = null,
  onAccept,
  onClose
}: {
  offer: LanguageOfferSummary
  progress?: LanguageOfferProgress
  error?: string | null
  onAccept: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = useId()
  const errorId = useId()
  return (
    <div
      role="region"
      aria-labelledby={titleId}
      aria-describedby={error ? errorId : undefined}
      className="relative w-[26rem] max-w-full rounded-lg border border-border bg-popover px-3.5 py-3.5 text-popover-foreground shadow-floating"
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-7"
        data-close-button
        onClick={onClose}
        aria-label={t('languages.suggestionClose', 'Close')}
      >
        <X className="size-3.5" />
      </Button>
      <div id={titleId} className="pr-7 text-[13.5px] leading-snug font-semibold">
        <Trans
          i18n={i18n}
          defaults={t('languages.suggestionTitle', 'Orca in <lang>{{language}}</lang>')}
          values={{ language: offer.name }}
          components={{ lang: <bdi lang={offer.locale} /> }}
        />
      </div>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1 pr-7 text-[12.5px] leading-snug text-pretty text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-3">
        {progress ? (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex min-h-9 items-center gap-2 text-[12.5px] text-muted-foreground"
          >
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
            <span>
              <LanguageOfferProgressLabel offer={offer} progress={progress} />
            </span>
          </span>
        ) : (
          // Why: Button is nowrap/shrink-0 by default; let a long language name wrap instead.
          <Button
            variant="default"
            className="h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onAccept}
          >
            {/* Why a span: Button is flex with a gap, which would split the label's text runs. */}
            <span>
              {error
                ? t('languages.offerRetry', 'Try again')
                : offer.installed
                  ? t('languages.suggestionUse', 'Use')
                  : t('languages.suggestionInstall', 'Install')}
            </span>
          </Button>
        )}
      </div>
    </div>
  )
}
