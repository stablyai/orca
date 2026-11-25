import { Trans } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { LanguageOfferSummary } from './device-language-offer'
import type { LanguageOfferProgress } from './use-language-offer-action'

export type LanguageSettingHint =
  /** Nothing to offer; the row shows no description unless an error needs one. */
  | { kind: 'browse' }
  /** The device language is only available as a community translation. */
  | { kind: 'offer'; offer: LanguageOfferSummary }
  /** A community translation is active; `previousName` is what "Switch back" restores. */
  | { kind: 'community'; publisher: string | null; previousName: string }

const linkClassName =
  'rounded-sm font-medium whitespace-nowrap text-foreground underline decoration-muted-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

/** The offer's action, naming the language in its own script. */
function LanguageOfferActionLabel({ offer }: { offer: LanguageOfferSummary }) {
  const t = useTranslate()
  return (
    <Trans
      i18n={i18n}
      defaults={
        offer.installed
          ? t('languages.offerUse', 'Use <lang>{{language}}</lang>')
          : t('languages.offerInstall', 'Install <lang>{{language}}</lang>…')
      }
      values={{ language: offer.name }}
      components={{ lang: <bdi lang={offer.locale} /> }}
    />
  )
}

/** Progress copy for accepting an offer; "Installing" only once consent is given. */
export function LanguageOfferProgressLabel({
  offer,
  progress
}: {
  offer: LanguageOfferSummary
  progress: Exclude<LanguageOfferProgress, null>
}) {
  const t = useTranslate()
  if (progress === 'confirming') {
    return <>{t('languages.offerConfirming', 'Waiting for confirmation…')}</>
  }
  if (progress === 'preparing') {
    return <>{t('languages.preparing', 'Preparing…')}</>
  }
  return (
    <Trans
      i18n={i18n}
      defaults={
        progress === 'switching'
          ? t('languages.offerSwitching', 'Switching to <lang>{{language}}</lang>…')
          : t('languages.offerInstalling', 'Installing <lang>{{language}}</lang>…')
      }
      values={{ language: offer.name }}
      components={{ lang: <bdi lang={offer.locale} /> }}
    />
  )
}

/** Description line under Settings → Language: one sentence plus at most one inline action. */
export function LanguagePackDiscoverySummary({
  hint,
  busy = false,
  pending = null,
  error = null,
  onAccept,
  onRestore
}: {
  hint: LanguageSettingHint
  /** Any language change in flight; disables the inline action. */
  busy?: boolean
  /** A pack being switched to or installed, from this row's offer or from the dropdown. */
  pending?: { offer: LanguageOfferSummary; progress: Exclude<LanguageOfferProgress, null> } | null
  error?: string | null
  onAccept: () => void
  onRestore: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (pending) {
    return (
      <span role="status" aria-live="polite">
        <LoaderCircle className="mr-1.5 inline size-3 animate-spin align-[-2px] motion-reduce:animate-none" />
        <span>
          <LanguageOfferProgressLabel offer={pending.offer} progress={pending.progress} />
        </span>
      </span>
    )
  }
  if (hint.kind === 'community') {
    // Why English literal: the active pack may be broken, so the escape hatch must stay readable.
    return (
      <span lang="en">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : hint.publisher ? (
          `Community translation by ${hint.publisher}.`
        ) : (
          'Community translation.'
        )}{' '}
        <button type="button" className={linkClassName} disabled={busy} onClick={onRestore}>
          Switch back to {hint.previousName}
        </button>
      </span>
    )
  }
  if (hint.kind === 'offer') {
    return (
      <>
        {error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : (
          t(
            'languages.offerSentence',
            'Orca is available in {{language}} as a community translation.',
            {
              language: hint.offer.englishName
            }
          )
        )}{' '}
        <button type="button" className={linkClassName} disabled={busy} onClick={onAccept}>
          {error ? (
            t('languages.offerRetry', 'Try again')
          ) : (
            <LanguageOfferActionLabel offer={hint.offer} />
          )}
        </button>
      </>
    )
  }
  // Why no default sentence: the row shows a description only when there is something to say.
  return error ? (
    <span role="alert" className="text-destructive">
      {error}
    </span>
  ) : null
}
