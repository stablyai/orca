import type { Platform } from './MobileHero'
import { translate } from '@/i18n/i18n'

export const PLATFORM_COPY: Record<
  Platform,
  { description: string; ctaLabel: string; url: string }
> = {
  ios: {
    description: translate(
      'auto.components.mobile.mobile.platform.copy.432db52b73',
      'Scan with your iPhone camera to open the App Store.'
    ),
    ctaLabel: 'Open App Store',
    url: 'https://apps.apple.com/app/orca-ide/id6766130217'
  },
  android: {
    description: translate(
      'auto.components.mobile.mobile.platform.copy.2a532d6fd7',
      'Scan with your Android camera to download the latest APK from GitHub Releases.'
    ),
    ctaLabel: 'Download APK',
    url: 'https://github.com/stablyai/orca/releases/download/mobile-v0.0.12/app-release.apk'
  }
}
