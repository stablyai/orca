import { ChevronLeft, CornerDownLeft, Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

type OnboardingFooterProps = {
  shouldShowSetUpLater: boolean
  opensAddProject: boolean
  /** Disables every footer action, including while work runs without a visible busy label. */
  locked: boolean
  onSetUpLater: () => void
  stepIndex: number
  onBack: () => void
  showPrimary: boolean
  primaryBusy: boolean
  primaryLabel: string
  shortcutModifierLabel: string
  onPrimary: () => void
}

export function OnboardingFooter({
  shouldShowSetUpLater,
  opensAddProject,
  locked,
  onSetUpLater,
  stepIndex,
  onBack,
  showPrimary,
  primaryBusy,
  primaryLabel,
  shortcutModifierLabel,
  onPrimary
}: OnboardingFooterProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <footer className="mt-6 flex flex-none items-center justify-between border-t border-border pt-5">
      {shouldShowSetUpLater ? (
        <button
          className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground"
          disabled={locked}
          onClick={onSetUpLater}
        >
          {opensAddProject
            ? t('components.onboarding.flow.actions.skipToProjectSetup', 'Skip to project setup')
            : t('auto.components.onboarding.OnboardingFooter.111d3f8d92', 'Set up later')}
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {stepIndex > 0 && (
          <button
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60"
            disabled={locked}
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
            {t('auto.components.onboarding.OnboardingFooter.ba58547306', 'Back')}
          </button>
        )}
        {showPrimary && (
          <button
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            aria-busy={primaryBusy}
            disabled={locked}
            onClick={onPrimary}
          >
            {primaryBusy ? <Loader2 className="size-4 animate-spin" /> : null}
            {primaryLabel}
            <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
              <span>{shortcutModifierLabel}</span>
              <CornerDownLeft className="size-3" />
            </span>
          </button>
        )}
      </div>
    </footer>
  )
}
