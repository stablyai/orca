import type { Platform } from './MobileHero'
import { translate } from '@/i18n/i18n'

// iOS offers App Store and TestFlight tracks; Android has a single APK track.
export type IosChannel = 'stable' | 'preview'

export type InstallCopy = { ctaLabel: string; url: string }

export const ANDROID_INSTALL_GUIDE_URL = 'https://www.onorca.dev/docs/android-apk'

const IOS_CHANNEL_URLS: Record<IosChannel, string> = {
  stable: 'https://apps.apple.com/app/orca-ide/id6766130217',
  preview: 'https://testflight.apple.com/join/YjeGMQBA'
}

const ANDROID_INSTALL_URL = 'https://www.onorca.dev/download/android'

function installCtaLabel(platform: Platform, iosChannel: IosChannel): string {
  if (platform !== 'ios') {
    return translate('auto.components.mobile.mobile.platform.copy.downloadApk', 'Download APK')
  }
  return iosChannel === 'preview'
    ? translate('auto.components.mobile.mobile.platform.copy.openTestFlight', 'Open TestFlight')
    : translate('auto.components.mobile.mobile.platform.copy.openAppStore', 'Open App Store')
}

export function getInstallCopy(platform: Platform, iosChannel: IosChannel): InstallCopy {
  return {
    ctaLabel: installCtaLabel(platform, iosChannel),
    url: platform === 'ios' ? IOS_CHANNEL_URLS[iosChannel] : ANDROID_INSTALL_URL
  }
}

export function getChannelTagline(iosChannel: IosChannel): string {
  return iosChannel === 'preview'
    ? translate(
        'auto.components.mobile.mobile.platform.copy.preview.tagline',
        'Newest features, updated daily.'
      )
    : translate(
        'auto.components.mobile.mobile.platform.copy.stable.tagline',
        'The public release, updated weekly.'
      )
}
