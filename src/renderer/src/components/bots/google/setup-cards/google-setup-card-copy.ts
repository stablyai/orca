import { getIntlLocale, translate } from '@/i18n/i18n'
import type {
  GoogleSetupMode,
  GoogleSetupStep
} from '../../../../../../shared/google/google-setup-run'
import type { GoogleServiceChoice } from '../../../../../../shared/google/google-scopes'
import { googleChoiceLabel, googleStepTitle } from '../google-copy'

export function googleSetupPathTitle(mode: GoogleSetupMode): string {
  switch (mode) {
    case 'do-it-for-me':
      return translate('bots.googleSetup.path.doIt', 'Do it for me')
    case 'guide-here':
      return translate('bots.googleSetup.path.guideHere', 'Guide me here')
    case 'guide-browser':
      return translate('bots.googleSetup.path.guideBrowser', 'Guide me in my browser')
  }
}

export function googleSetupPathNote(mode: GoogleSetupMode, botName: string): string {
  switch (mode) {
    case 'do-it-for-me':
      return translate('bots.googleSetup.path.doItNote', '{{bot}} clicks through it', {
        bot: botName
      })
    case 'guide-here':
      return translate('bots.googleSetup.path.guideHereNote', 'You click, in Orca')
    case 'guide-browser':
      return translate('bots.googleSetup.path.guideBrowserNote', 'You click, in your browser')
  }
}

export function googleSetupServicesList(choices: readonly GoogleServiceChoice[]): string {
  return new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
    choices.map(googleChoiceLabel)
  )
}

/** A step's name in the progress list. */
export function googleSetupStepTitle(
  step: GoogleSetupStep,
  choices: readonly GoogleServiceChoice[]
): string {
  if (step === 'account') {
    return translate('bots.googleSetup.step.account', 'Sign in to Google')
  }
  if (step === 'connect') {
    return translate('bots.googleSetup.step.connect', 'Connect and check')
  }
  return googleStepTitle(step, googleSetupServicesList(choices))
}

export function googleSetupReceiptChose(what: string): string {
  return translate('bots.googleSetup.receipt.chose', '✓ You chose {{what}}', { what })
}

/** The owner's three cards: how, which services, then their sign-in. */
export function googleSetupOwnerStep(step: 1 | 2 | 3): string {
  return translate('bots.googleSetup.ownerStep', 'Step {{step}} of 3', { step })
}
