import { ChevronLeft, CornerDownLeft, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type OnboardingFooterProps = {
  shouldShowSkipToProjectSetup: boolean
  busyLabel: string | null
  onSkipToRepo: () => void
  stepIndex: number
  onBack: () => void
  showPrimary: boolean
  primaryBusy: boolean
  primaryLabel: string
  shortcutModifierLabel: string
  onPrimary: () => void
}

export function OnboardingFooter({
  shouldShowSkipToProjectSetup,
  busyLabel,
  onSkipToRepo,
  stepIndex,
  onBack,
  showPrimary,
  primaryBusy,
  primaryLabel,
  shortcutModifierLabel,
  onPrimary
}: OnboardingFooterProps): React.JSX.Element {
  return (
    <footer className="mt-6 flex flex-none items-center justify-between border-t border-border pt-5">
      {shouldShowSkipToProjectSetup ? (
        <button
          className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground"
          disabled={Boolean(busyLabel)}
          onClick={onSkipToRepo}
        >
          {translate("auto.components.onboarding.OnboardingFooter.111d3f8d92", "Skip to project setup")}</button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {stepIndex > 0 && (
          <button
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60"
            disabled={Boolean(busyLabel)}
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
            {translate("auto.components.onboarding.OnboardingFooter.ba58547306", "Back")}</button>
        )}
        {showPrimary && (
          <button
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            aria-busy={primaryBusy}
            disabled={Boolean(busyLabel)}
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
