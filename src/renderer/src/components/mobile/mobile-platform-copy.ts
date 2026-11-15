import type { Platform } from './MobileHero'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type InstallCopy = { ctaLabel: string; url: string }

export const ANDROID_INSTALL_GUIDE_URL = 'https://orca.dev/docs/android-apk'

export function getInstallCopy(platform: Platform, t: Translate = translate): InstallCopy {
  return platform === 'ios'
    ? {
        ctaLabel: t('auto.components.mobile.mobile.platform.copy.openAppStore', 'Open App Store'),
        url: 'https://apps.apple.com/app/orca-ide/id6766130217'
      }
    : {
        ctaLabel: t('auto.components.mobile.mobile.platform.copy.downloadApk', 'Download APK'),
        url: 'https://orca.dev/download/android'
      }
}
