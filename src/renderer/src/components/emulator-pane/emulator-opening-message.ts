import type { EmulatorSelectionRequired } from '../../../../shared/emulator-opening-preferences'
import { translate } from '@/i18n/i18n'
export function emulatorOpeningMessage(reason: EmulatorSelectionRequired): string {
  switch (reason) {
    case 'missing':
      return translate(
        'emulator.opening.missing',
        'The saved device is no longer on this computer. Choose another device.'
      )
    case 'unavailable':
      return translate(
        'emulator.opening.unavailable',
        'The saved device runtime is unavailable. Choose another device or install its runtime.'
      )
    case 'ask':
      return translate('emulator.opening.askPrompt', 'Choose a device to open.')
    case 'first-use':
      return translate(
        'emulator.opening.firstUse',
        'Choose your first device. Orca will remember successful selections on this computer.'
      )
  }
}
