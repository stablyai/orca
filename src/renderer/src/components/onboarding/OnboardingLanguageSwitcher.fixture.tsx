import { defineFixture } from '../../component-fixtures/component-fixture'
import { OnboardingLanguageSwitcherButton } from './OnboardingLanguageSwitcher'
import type { OnboardingLanguageOffer } from './use-onboarding-language-offer'

const noop = (): void => {}

// Mirrors OnboardingFlow's header row so the control is judged next to the wordmark.
function Header({ offer }: { offer: OnboardingLanguageOffer | null }) {
  return (
    <div className="rounded-xl border border-border bg-card px-8 pt-9 pb-8 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <div className="text-base font-semibold tracking-tight">Orca</div>
        <OnboardingLanguageSwitcherButton offer={offer} onOpen={noop} />
      </div>
      <div className="mt-10 mb-2 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        Welcome to Orca
      </div>
      <h1 className="text-[34px] leading-[1.15] font-semibold tracking-tight">
        How do you want to work with agents?
      </h1>
    </div>
  )
}

export const headerDefault = defineFixture({
  width: 900,
  render: () => <Header offer={null} />
})

export const headerOffer = defineFixture({
  width: 900,
  render: () => <Header offer={{ locale: 'it', name: 'italiano' }} />
})

export const headerOfferRtl = defineFixture({
  width: 900,
  render: () => <Header offer={{ locale: 'ar', name: 'العربية' }} />
})

export const headerOfferCjkNarrow = defineFixture({
  width: 420,
  render: () => <Header offer={{ locale: 'yue', name: '粵語' }} />
})
