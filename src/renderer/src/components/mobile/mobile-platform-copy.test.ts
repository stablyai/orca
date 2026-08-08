import { describe, expect, it } from 'vitest'
import {
  getInstallCopy,
  ORCA_ANDROID_APK_URL,
  ORCA_ANDROID_APK_RELEASE_TAG
} from './mobile-platform-copy'

describe('mobile platform install copy', () => {
  it('pins the Android APK to the published mobile-android release tag (#11444)', () => {
    expect(ORCA_ANDROID_APK_RELEASE_TAG).toBe('mobile-android-v0.0.42')
    expect(ORCA_ANDROID_APK_URL).toContain(ORCA_ANDROID_APK_RELEASE_TAG)
    expect(getInstallCopy('android', 'stable').url).toBe(ORCA_ANDROID_APK_URL)
  })
})
