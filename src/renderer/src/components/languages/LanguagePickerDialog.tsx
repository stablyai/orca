import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { track } from '@/diagnostics/telemetry/telemetry'
import { onboardingLanguageMetadata } from '../onboarding/onboarding-language-telemetry'
import { LanguageBrowser } from './LanguageBrowser'

export function LanguagePickerDialog({
  open,
  onOpenChange,
  onboarding = false,
  initialQuery,
  returnFocus
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onboarding?: boolean
  /** Prefills the search, e.g. from a settings search that matched no built-in language. */
  initialQuery?: string
  /** The control to refocus on close, usually whatever opened the picker. */
  returnFocus?: () => HTMLElement | null
}): React.JSX.Element {
  useEffect(() => {
    if (open && onboarding) {
      track('onboarding_language_picker_opened', onboardingLanguageMetadata())
    }
    if (open && !useAppStore.getState().settings?.languagePackSuggestionShown) {
      void useAppStore
        .getState()
        .updateSettings({ languagePackSuggestionShown: true })
        .catch(() => undefined)
    }
  }, [open, onboarding])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        surface="panel"
        className="z-[110] flex max-h-[calc(100dvh-3rem)] flex-col overflow-hidden sm:max-w-lg"
        overlayClassName="z-[105]"
        // Why: keyboard and pointer opens land on the same control: the pinned row, or the search.
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.()
          if (target?.isConnected) {
            event.preventDefault()
            target.focus({ preventScroll: true })
          }
        }}
        onOpenAutoFocus={(event) => {
          const target =
            event.currentTarget instanceof HTMLElement
              ? event.currentTarget.querySelector<HTMLElement>('[data-picker-autofocus]')
              : null
          if (target) {
            event.preventDefault()
            target.focus({ preventScroll: true })
          }
        }}
      >
        {open && (
          <LanguageBrowser
            onboarding={onboarding}
            initialQuery={initialQuery}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
