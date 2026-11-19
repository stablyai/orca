import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getEmulatorScreenAriaLabel(
  isLive: boolean,
  keyboardCaptureActive: boolean,
  t: Translate = translate
): string | undefined {
  if (!isLive) {
    return undefined
  }
  return keyboardCaptureActive
    ? t(
        'auto.components.emulator.pane.emulator.device.frame.8f25ffaf8a',
        'Emulator screen, keyboard captured. Press Escape to release.'
      )
    : t('auto.components.emulator.pane.emulator.device.frame.9406c15775', 'Emulator screen')
}
