import { translate } from '@/i18n/i18n'

const KNOWN_CLI_DETAILS: { test: RegExp | string; key: string; fallback: string }[] = [
  {
    test: 'Development mode uses a generated launcher for validation only.',
    key: 'auto.lib.cli.detail.devLauncherOnly',
    fallback: 'Development mode uses a generated launcher for validation only.'
  },
  {
    test: 'The bundled CLI launcher is missing from this Orca build.',
    key: 'auto.lib.cli.detail.launcherMissing',
    fallback: 'The bundled CLI launcher is missing from this Orca build.'
  },
  {
    test: 'CLI registration is not implemented on this platform.',
    key: 'auto.lib.cli.detail.platformUnsupported',
    fallback: 'CLI registration is not implemented on this platform.'
  }
]

const KNOWN_ANDROID_MESSAGES: { test: string; key: string; fallback: string }[] = [
  {
    test: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.',
    key: 'auto.lib.emulator.androidSdkNotFound',
    fallback: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
  }
]

export function formatCliUserFacingDetail(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  for (const known of KNOWN_CLI_DETAILS) {
    const matched =
      typeof known.test === 'string'
        ? raw === known.test || raw.includes(known.test)
        : known.test.test(raw)
    if (matched) {
      return translate(known.key, known.fallback)
    }
  }
  return raw
}

export function formatEmulatorAvailabilityUserFacingMessage(
  raw: string | null | undefined
): string {
  if (!raw?.trim()) {
    return ''
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
