import { describe, expect, it } from 'vitest'
import { getInstallCopy, ORCA_ANDROID_APK_URL } from './mobile-platform-copy'

describe('mobile platform install copy', () => {
  it('pins the Android APK to the published mobile-android release tag (#11444)', () => {
    expect(ORCA_ANDROID_APK_URL).toBe(
      'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.43/app-release.apk'
    )
    expect(getInstallCopy('android', 'stable').url).toBe(ORCA_ANDROID_APK_URL)
  })
})
