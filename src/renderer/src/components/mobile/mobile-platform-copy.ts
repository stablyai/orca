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

// Why: pin the published mobile-android tag used by README / Settings so a
// stale APK link does not strand downloads while releases advance (#11444).
export const ORCA_ANDROID_APK_RELEASE_TAG = 'mobile-android-v0.0.42'
export const ORCA_ANDROID_APK_URL = `https://github.com/stablyai/orca/releases/download/${ORCA_ANDROID_APK_RELEASE_TAG}/app-release.apk`

const ANDROID_COPY: InstallCopy = {
  ctaLabel: 'Download APK',
  url: ORCA_ANDROID_APK_URL
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
