import { translate } from '@/i18n/i18n'
import { formatCliUserFacingDetail } from '../cli/cli-user-facing-detail'

const KNOWN_ANDROID_MESSAGES: { test: string; key: string; fallback: string }[] = [
  {
    test: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.',
    key: 'auto.lib.emulator.androidSdkNotFound',
    fallback: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
  }
]

const KNOWN_IOS_MESSAGES: { test: string; key: string; fallback: string }[] = [
  {
    test: 'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.',
    key: 'auto.lib.emulator.xcodeSimulatorToolsUnavailable',
    fallback:
      'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'
  }
]

export function formatEmulatorAvailabilityUserFacingMessage(
  raw: string | null | undefined
): string {
  if (!raw?.trim()) {
    return ''
  }
  for (const known of KNOWN_IOS_MESSAGES) {
    if (raw === known.test || raw.includes(known.test)) {
      return translate(known.key, known.fallback)
    }
  }
  const android = formatAndroidSdkUserFacingMessage(raw)
  if (android !== raw) {
    return android
  }
  return formatCliUserFacingDetail(raw)
}

export function formatAndroidSdkUserFacingMessage(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  for (const known of KNOWN_ANDROID_MESSAGES) {
    if (raw === known.test || raw.includes(known.test)) {
      return translate(known.key, known.fallback)
    }
  }
  return raw
}
