import { useRef } from 'react'
import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LanguagePickerDialog } from '@/components/languages/LanguagePickerDialog'
import { currentFocusTarget, firstConnected } from '@/components/languages/focus-return'
import type { OnboardingLanguageOffer } from './use-onboarding-language-offer'

/**
 * Header language control: always the English "Language" escape hatch; with an offer it also
 * names the offered language in its own script, e.g. "Language · italiano".
 */
export function OnboardingLanguageSwitcherButton({
  offer,
  onOpen,
  buttonRef
}: {
  offer: OnboardingLanguageOffer | null
  onOpen: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    // Why English literal: the escape hatch for anyone who can't read the current UI.
    <Button ref={buttonRef} variant="ghost" size="sm" lang="en" onClick={onOpen}>
      <Languages />
      {/* Why a span: Button is flex with a gap, which would split the label's text runs. */}
      <span>
        Language
        {offer ? (
          <>
            {' · '}
            <bdi lang={offer.locale}>{offer.name}</bdi>
          </>
        ) : null}
      </span>
    </Button>
  )
}

export function OnboardingLanguageSwitcher({
  offer,
  open,
  onOpenChange
}: {
  offer: OnboardingLanguageOffer | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const opener = useRef<HTMLElement | null>(null)
  const languageButton = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <OnboardingLanguageSwitcherButton
        offer={offer}
        buttonRef={languageButton}
        onOpen={() => {
          opener.current = currentFocusTarget()
          onOpenChange(true)
        }}
      />
      <LanguagePickerDialog
        open={open}
        onOpenChange={onOpenChange}
        onboarding
        returnFocus={() => firstConnected(opener.current, languageButton.current)}
      />
    </>
  )
}
