import { describe, expect, it } from 'vitest'
import {
  formatAdhocVersion,
  formatHourlyVersion,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  isAdhocVersion,
  isChannelSupportedOnPlatform,
  isHourlyVersion,
  isReleaseChannel,
  parseAdhocVersionStamp,
  parseDevBuildStamp,
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
    expect(getVersionChannel('1.4.160-adhoc.20260728140533')).toBe('adhoc')
    expect(getVersionChannel('not-a-version')).toBeNull()
  })

  // Why: hourly tags must never resolve to the main repo — the releases atom feed
  // exposes only 10 entries, so 24 hourly tags a day would evict every stable/RC
  // entry and leave real users with nothing to update to.
  it('keeps dev builds out of the main release repo, and apart from each other', () => {
    expect(getReleaseRepoForChannel('hourly')).toBe('stablyai/orca-hourly')
    // Why adhoc gets a third repo rather than sharing hourly's: an unlanded
    // branch build must never surface to someone who only meant to ride main.
    expect(getReleaseRepoForChannel('adhoc')).toBe('stablyai/orca-adhoc')
    expect(getReleaseRepoForChannel('stable')).toBe('stablyai/orca')
    expect(getReleaseRepoForChannel('rc')).toBe('stablyai/orca')
  })

  it('marks exactly the dev channels as having their own repo', () => {
    expect(hasDedicatedReleaseRepo('hourly')).toBe(true)
    expect(hasDedicatedReleaseRepo('adhoc')).toBe(true)
    expect(hasDedicatedReleaseRepo('stable')).toBe(false)
    expect(hasDedicatedReleaseRepo('rc')).toBe(false)
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
    expect(getReleaseNotesUrlForVersion('1.4.160-adhoc.20260728140533')).toBe(
      'https://github.com/stablyai/orca-adhoc/releases/tag/v1.4.160-adhoc.20260728140533'
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

  // Why seconds and not hourly's minutes: adhoc builds are dispatched on demand,
  // so two people cutting from different branches inside the same minute is
  // ordinary — at minute resolution the second would collide on the tag.
  it('round-trips an adhoc version stamp as UTC, to the second', () => {
    const version = formatAdhocVersion('1.4.160', '20260728140533')
    expect(isAdhocVersion(version)).toBe(true)
    expect(parseAdhocVersionStamp(version)?.toISOString()).toBe('2026-07-28T14:05:33.000Z')
  })

  it('keeps the two dev stamp formats from matching each other', () => {
    expect(isAdhocVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    // A 12-digit adhoc tail is an hourly stamp wearing the wrong identifier, not
    // a second-resolution one; rejecting it keeps the parse unambiguous.
    expect(isAdhocVersion('1.4.160-adhoc.202607281405')).toBe(false)
  })

  it('rejects impossible adhoc calendar stamps, including the seconds field', () => {
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260230000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20261301000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101250000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101000060')).toBeNull()
    expect(parseAdhocVersionStamp('not-a-version-adhoc.20260101000000')).toBeNull()
  })

  // Why one entry point for both: the picker renders a row without knowing which
  // dev channel produced it, so a channel added without a case here would fall
  // back to showing its raw opaque timestamp tail.
  it('reads the build timestamp of either dev channel', () => {
    expect(parseDevBuildStamp('1.4.160-hourly.202607281405')?.toISOString()).toBe(
      '2026-07-28T14:05:00.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-adhoc.20260728140533')?.toISOString()).toBe(
      '2026-07-28T14:05:33.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-rc.3')).toBeNull()
    expect(parseDevBuildStamp('1.4.160')).toBeNull()
  })

  // Why: both dev workflows are macOS-only, so the channels have no artifact to
  // offer elsewhere. Both the picker and the main-process check read this, so a
  // regression here would silently re-expose an uninstallable channel.
  it('offers the dev channels only on macOS', () => {
    for (const channel of ['hourly', 'adhoc'] as const) {
      expect(isChannelSupportedOnPlatform(channel, 'darwin')).toBe(true)
      expect(isChannelSupportedOnPlatform(channel, 'linux')).toBe(false)
      expect(isChannelSupportedOnPlatform(channel, 'win32')).toBe(false)
    }
  })

  it('offers stable and rc on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(isChannelSupportedOnPlatform('stable', platform)).toBe(true)
      expect(isChannelSupportedOnPlatform('rc', platform)).toBe(true)
    }
  })

  it('accepts only known channels', () => {
    expect(isReleaseChannel('hourly')).toBe(true)
    expect(isReleaseChannel('adhoc')).toBe(true)
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

  // Why adhoc sits at the very bottom: it is an unlanded branch, the least
  // trustworthy thing the updater can hand anyone. Every other channel of the
  // same base version must outrank it so no routine check ever selects one.
  it('orders an adhoc build below every other channel of its base version', () => {
    const adhoc = '1.4.160-adhoc.20260728140533'
    expect(compareAppVersions(adhoc, '1.4.160')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-rc.1')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-hourly.202607280000')).toBeLessThan(0)
  })

  it('sorts consecutive adhoc builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`
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
})
