import { translate } from '@/i18n/i18n'
import { emulatorErrorText } from '@/lib/emulator-error-copy'

export function emulatorListDevicesErrorText(error: unknown): string {
  return emulatorErrorText(
    error,
    translate('emulator.pane.listDevicesFailed', 'Could not list emulator devices.')
  )
}

export function emulatorStartErrorText(error: unknown): string {
  return emulatorErrorText(
    error,
    translate(
      'emulator.pane.startFailed',
      'Could not start the emulator. Make sure Xcode (iOS) or Android Studio (Android) is set up, then try another device.'
    )
  )
}

export function emulatorShutdownErrorText(error: unknown): string {
  return emulatorErrorText(
    error,
    translate(
      'emulator.pane.shutdownFailed',
      'Could not shut down the emulator. Try again, or stop it from your emulator manager.'
    )
  )
}

export function noEmulatorDevicesError(): Error {
  return new Error(
    translate(
      'emulator.pane.noDevices',
      'No emulator devices found. Add an iOS Simulator in Xcode, or an Android Virtual Device in Android Studio.'
    )
  )
}
