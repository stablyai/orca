import type { Platform } from './MobileHero'
import { translate } from '@/i18n/i18n'

// iOS ships two App Store tracks: the public App Store build (slower, ~weekly)
// and the TestFlight preview build (daily). Android only ships one APK track.
export type IosChannel = 'stable' | 'preview'

export type InstallCopy = { ctaLabel: string; url: string }

const IOS_CHANNEL_COPY: Record<IosChannel, InstallCopy> = {
  stable: {
    ctaLabel: 'Open App Store',
    url: 'https://apps.apple.com/app/orca-ide/id6766130217'
  },
  preview: {
    ctaLabel: 'Open TestFlight',
    url: 'https://testflight.apple.com/join/YjeGMQBA'
  }
}

const ANDROID_COPY: InstallCopy = {
  ctaLabel: 'Download APK',
  url: 'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.26/app-release.apk'
}

export function getInstallCopy(platform: Platform, iosChannel: IosChannel): InstallCopy {
  return platform === 'ios' ? IOS_CHANNEL_COPY[iosChannel] : ANDROID_COPY
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
