import { describe, expect, it } from 'vitest'
import {
  formatHourlyVersion,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  getVersionChannel,
  isChannelSupportedOnPlatform,
  isHourlyVersion,
  isReleaseChannel,
  parseHourlyVersionStamp,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild
} from './release-channel'
import { compareAppVersions } from './app-version'

describe('release channel', () => {
  it('classifies versions by channel', () => {
    expect(getVersionChannel('1.4.160')).toBe('stable')
    expect(getVersionChannel('v1.4.160')).toBe('stable')
    expect(getVersionChannel('1.4.160-rc.3')).toBe('rc')
    expect(getVersionChannel('1.4.160-hourly.202607281400')).toBe('hourly')
    expect(getVersionChannel('not-a-version')).toBeNull()
  })

  // Why: hourly tags must never resolve to the main repo — the releases atom feed
  // exposes only 10 entries, so 24 hourly tags a day would evict every stable/RC
  // entry and leave real users with nothing to update to.
  it('keeps hourly builds out of the main release repo', () => {
    expect(getReleaseRepoForChannel('hourly')).toBe('stablyai/orca-hourly')
    expect(getReleaseRepoForChannel('stable')).toBe('stablyai/orca')
    expect(getReleaseRepoForChannel('rc')).toBe('stablyai/orca')
  })

  // Why: an hourly tag linked against the main repo 404s — the tag only exists
  // in the hourly repo.
  it('builds release-notes links against the repo that published the version', () => {
    expect(getReleaseNotesUrlForVersion('1.4.160-hourly.202607281400')).toBe(
      'https://github.com/stablyai/orca-hourly/releases/tag/v1.4.160-hourly.202607281400'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.160'
    )
    expect(getReleaseNotesUrlForVersion('v1.4.160-rc.3')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.160-rc.3'
    )
    expect(getReleaseNotesUrlForVersion(null)).toBe('https://github.com/stablyai/orca/releases')
  })

  it('round-trips an hourly version stamp as UTC', () => {
    const version = formatHourlyVersion('1.4.160', '202607281405')
    expect(isHourlyVersion(version)).toBe(true)
    expect(parseHourlyVersionStamp(version)?.toISOString()).toBe('2026-07-28T14:05:00.000Z')
  })

  it('rejects malformed hourly identifiers', () => {
    expect(isHourlyVersion('1.4.160-hourly')).toBe(false)
    expect(isHourlyVersion('1.4.160-hourly.2026')).toBe(false)
    expect(isHourlyVersion('1.4.160-rc.3')).toBe(false)
    expect(parseHourlyVersionStamp('1.4.160-rc.3')).toBeNull()
  })

  // Why: an unanchored tail match also accepted garbage prefixes, and Date.UTC
  // rolls impossible dates forward, so `...hourly.202602300000` rendered as
  // March 2 rather than being rejected.
  it('rejects a bad base version and impossible calendar stamps', () => {
    expect(parseHourlyVersionStamp('not-a-version-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202602300000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202613010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202601012500')).toBeNull()
    // Leap day 2028 is real and must still parse.
    expect(parseHourlyVersionStamp('1.4.160-hourly.202802290000')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    )
  })

  // Why: the hourly workflow is macOS-only, so the channel has no artifact to
  // offer elsewhere. Both the picker and the main-process check read this, so a
  // regression here would silently re-expose an uninstallable channel.
  it('offers hourly only on macOS', () => {
    expect(isChannelSupportedOnPlatform('hourly', 'darwin')).toBe(true)
    expect(isChannelSupportedOnPlatform('hourly', 'linux')).toBe(false)
    expect(isChannelSupportedOnPlatform('hourly', 'win32')).toBe(false)
  })

  it('offers stable and rc on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(isChannelSupportedOnPlatform('stable', platform)).toBe(true)
      expect(isChannelSupportedOnPlatform('rc', platform)).toBe(true)
    }
  })

  it('accepts only known channels', () => {
    expect(isReleaseChannel('hourly')).toBe(true)
    expect(isReleaseChannel('stable')).toBe(true)
    expect(isReleaseChannel('nightly')).toBe(false)
    expect(isReleaseChannel(null)).toBe(false)
    expect(isReleaseChannel(undefined)).toBe(false)
  })

  // Why: consecutive hourlies differ only in the timestamp tail, so semver
  // ordering must follow the clock or the picker offers them out of order.
  it('sorts consecutive hourly builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'hourly',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/v${version}`
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-hourly.202607280900'),
      build('1.4.160-hourly.202607281400'),
      build('1.4.160-hourly.202607281000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-hourly.202607281400',
      '1.4.160-hourly.202607281000',
      '1.4.160-hourly.202607280900'
    ])
  })

  // Why: an hourly is cut from main and must not read as newer than the stable it
  // is based on, or stable users would be offered it by an ordinary check.
  it('orders an hourly below its own stable release', () => {
    expect(compareAppVersions('1.4.160-hourly.202607281400', '1.4.160')).toBeLessThan(0)
  })
})
