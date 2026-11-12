import { describe, expect, it } from 'vitest'
import {
  isAdhocVersion,
  isDailyVersion,
  isHourlyVersion,
  parseAdhocVersionStamp,
  parseDailyVersionStamp,
  parseHourlyVersionStamp,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'
import { compareAppVersions } from './app-version'

describe('release channel', () => {
  // Reject garbage-prefix versions and Date.UTC’s normalization of impossible dates (February 30→March 2).
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
    expect(parseDailyVersionStamp('1.4.160-daily.202602300000')).toBeNull()
    expect(parseDailyVersionStamp('not-a-version-daily.202601010000')).toBeNull()
  })

  it('keeps the dev stamp formats from matching each other', () => {
    expect(isAdhocVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    expect(isDailyVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-daily.202607281300')).toBe(false)
    expect(isDailyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    // Minute-only tails are not valid second-resolution adhoc stamps.
    expect(isAdhocVersion('1.4.160-adhoc.202607281405')).toBe(false)
  })

  it('rejects impossible adhoc calendar stamps, including the seconds field', () => {
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260230000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20261301000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101250000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101000060')).toBeNull()
    expect(parseAdhocVersionStamp('not-a-version-adhoc.20260101000000')).toBeNull()
  })

  // Installed signed Windows apps reject unsigned dev installers via baked-in publisherName; future builds cannot fix them.
  // Dev apps omit the name, allowing every outbound switch including stable.
  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual('rc', 'hourly')).toBe(true)
    expect(manual('stable', 'daily')).toBe(true)
    // Unknown running versions conservatively assume signed and offer a working manual download.
    expect(manual(null, 'adhoc')).toBe(true)

    // Already unsigned — the updater skips verification entirely from here.
    expect(manual('adhoc', 'hourly')).toBe(false)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('adhoc', 'rc')).toBe(false)

    expect(manual('stable', 'rc')).toBe(false)
    expect(manual('rc', 'stable')).toBe(false)
  })

  // Timestamp tails distinguish consecutive hourlies; keep picker ordering chronological.
  it('sorts consecutive hourly builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'hourly',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/v${version}`,
      installerUrl: null
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

  // Main-derived hourlies must rank below their stable base so routine checks cannot select them.
  it('orders an hourly below its own stable release', () => {
    expect(compareAppVersions('1.4.160-hourly.202607281400', '1.4.160')).toBeLessThan(0)
  })

  it('orders a daily below its own stable release and below hourly of the same base', () => {
    expect(compareAppVersions('1.4.160-daily.202607281300', '1.4.160')).toBeLessThan(0)
    expect(
      compareAppVersions('1.4.160-daily.202607281300', '1.4.160-hourly.202607281400')
    ).toBeLessThan(0)
  })

  // Unlanded adhoc builds rank below all same-base channels; routine updates must never select them.
  it('orders an adhoc build below every other channel of its base version', () => {
    const adhoc = '1.4.160-adhoc.20260728140533'
    expect(compareAppVersions(adhoc, '1.4.160')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-rc.1')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-hourly.202607280000')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-daily.202607281300')).toBeLessThan(0)
  })

  it('sorts consecutive adhoc builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-adhoc.20260728140502'),
      build('1.4.160-adhoc.20260728140541'),
      build('1.4.160-adhoc.20260728090000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-adhoc.20260728140541',
      '1.4.160-adhoc.20260728140502',
      '1.4.160-adhoc.20260728090000'
    ])
  })

  it('sorts dev builds by their cut time across different base versions', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.207-adhoc.20260919025813'),
      build('1.4.206-adhoc.20260919173504')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.206-adhoc.20260919173504',
      '1.4.207-adhoc.20260919025813'
    ])
  })
})
