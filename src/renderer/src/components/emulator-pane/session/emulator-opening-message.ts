import type { EmulatorSelectionRequired } from '../../../../../shared/emulator/emulator-opening-preferences'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
export function emulatorOpeningMessage(
  reason: EmulatorSelectionRequired,
  t: Translate = translate,
  /** The paired server that runs the simulators; null for this computer. */
  serverLabel: string | null = null
): string {
  switch (reason) {
    case 'missing':
      return serverLabel
        ? t(
            'emulator.opening.missingOnServer',
            'The saved device is no longer on {{host}}. Choose another device.',
            { host: serverLabel }
          )
        : t(
            'emulator.opening.missing',
            'The saved device is no longer on this computer. Choose another device.'
          )
    case 'unavailable':
      return t(
        'emulator.opening.unavailable',
        'The saved device runtime is unavailable. Choose another device or install its runtime.'
      )
    case 'ask':
      return t('emulator.opening.askPrompt', 'Choose a device to open.')
    case 'first-use':
      return serverLabel
        ? t(
            'emulator.opening.firstUseOnServer',
            'Choose your first device. Orca will remember successful selections on {{host}}.',
            { host: serverLabel }
          )
        : t(
            'emulator.opening.firstUse',
            'Choose your first device. Orca will remember successful selections on this computer.'
          )
  }
}
