import { translate } from '@/i18n/i18n'

export function getEmulatorScreenAriaLabel(
  isLive: boolean,
  keyboardCaptureActive: boolean
): string | undefined {
  if (!isLive) {
    return undefined
  }
  return keyboardCaptureActive
    ? translate(
        'auto.components.emulator.pane.emulator.device.frame.8f25ffaf8a',
        'Emulator screen, keyboard captured. Press Escape to release.'
      )
    : translate('auto.components.emulator.pane.emulator.device.frame.9406c15775', 'Emulator screen')
}
