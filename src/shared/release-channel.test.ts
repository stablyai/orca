import { describe, expect, it } from 'vitest'
import {
  findInstallerAssetName,
  formatAdhocVersion,
  formatDailyVersion,
  formatHourlyVersion,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  hasInstallableArtifactForPlatform,
  isAdhocVersion,
  isChannelSupportedOnPlatform,
  isDailyVersion,
  isHourlyVersion,
  isReleaseChannel,
  parseAdhocVersionStamp,
  parseDailyVersionStamp,
  parseDevBuildStamp,
  parseHourlyVersionStamp,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'
import { compareAppVersions } from './app-version'

describe('release channel', () => {
  it('classifies versions by channel', () => {
    expect(getVersionChannel('1.4.160')).toBe('stable')
    expect(getVersionChannel('v1.4.160')).toBe('stable')
    expect(getVersionChannel('1.4.160-rc.3')).toBe('rc')
    expect(getVersionChannel('1.4.160-hourly.202607281400')).toBe('hourly')
    expect(getVersionChannel('1.4.160-daily.202607281300')).toBe('daily')
    expect(getVersionChannel('1.4.160-adhoc.20260728140533')).toBe('adhoc')
    expect(getVersionChannel('not-a-version')).toBeNull()
  })

  // Why: hourly tags must never resolve to the main repo — the releases atom feed
  // exposes only 10 entries, so 24 hourly tags a day would evict every stable/RC
  // entry and leave real users with nothing to update to.
  it('keeps dev builds out of the main release repo, and apart from each other', () => {
    expect(getReleaseRepoForChannel('hourly')).toBe('stablyai/orca-hourly')
    expect(getReleaseRepoForChannel('daily')).toBe('stablyai/orca-daily')
    // Why adhoc gets its own repo rather than sharing hourly's: an unlanded
    // branch build must never surface to someone who only meant to ride main.
    expect(getReleaseRepoForChannel('adhoc')).toBe('stablyai/orca-adhoc')
    expect(getReleaseRepoForChannel('stable')).toBe('stablyai/orca')
    expect(getReleaseRepoForChannel('rc')).toBe('stablyai/orca')
  })

  it('marks exactly the dev channels as having their own repo', () => {
    expect(hasDedicatedReleaseRepo('hourly')).toBe(true)
    expect(hasDedicatedReleaseRepo('daily')).toBe(true)
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
    expect(getReleaseNotesUrlForVersion('1.4.160-daily.202607281300')).toBe(
      'https://github.com/stablyai/orca-daily/releases/tag/v1.4.160-daily.202607281300'
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

  it('round-trips a daily version stamp as UTC', () => {
    const version = formatDailyVersion('1.4.160', '202607281300')
    expect(isDailyVersion(version)).toBe(true)
    expect(parseDailyVersionStamp(version)?.toISOString()).toBe('2026-07-28T13:00:00.000Z')
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
    expect(parseDailyVersionStamp('1.4.160-daily.202602300000')).toBeNull()
    expect(parseDailyVersionStamp('not-a-version-daily.202601010000')).toBeNull()
  })

  // Why seconds and not hourly's minutes: adhoc builds are dispatched on demand,
  // so two people cutting from different branches inside the same minute is
  // ordinary — at minute resolution the second would collide on the tag.
  it('round-trips an adhoc version stamp as UTC, to the second', () => {
    const version = formatAdhocVersion('1.4.160', '20260728140533')
    expect(isAdhocVersion(version)).toBe(true)
    expect(parseAdhocVersionStamp(version)?.toISOString()).toBe('2026-07-28T14:05:33.000Z')
  })

  it('keeps the dev stamp formats from matching each other', () => {
    expect(isAdhocVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    expect(isDailyVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-daily.202607281300')).toBe(false)
    expect(isDailyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
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

  // Why one entry point for all: the picker renders a row without knowing which
  // dev channel produced it, so a channel added without a case here would fall
  // back to showing its raw opaque timestamp tail.
  it('reads the build timestamp of any dev channel', () => {
    expect(parseDevBuildStamp('1.4.160-hourly.202607281405')?.toISOString()).toBe(
      '2026-07-28T14:05:00.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-daily.202607281300')?.toISOString()).toBe(
      '2026-07-28T13:00:00.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-adhoc.20260728140533')?.toISOString()).toBe(
      '2026-07-28T14:05:33.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-rc.3')).toBeNull()
    expect(parseDevBuildStamp('1.4.160')).toBeNull()
  })

  // Why: the dev workflows build macOS and Windows but not Linux, so a Linux
  // install has no artifact to offer. Both the picker and the main-process check
  // read this, so a regression here would silently expose an uninstallable
  // channel.
  it('offers the dev channels on macOS and Windows but not Linux', () => {
    for (const channel of ['hourly', 'daily', 'adhoc'] as const) {
      expect(isChannelSupportedOnPlatform(channel, 'darwin')).toBe(true)
      expect(isChannelSupportedOnPlatform(channel, 'win32')).toBe(true)
      expect(isChannelSupportedOnPlatform(channel, 'linux')).toBe(false)
    }
  })

  // The whole Windows story in one test. electron-updater verifies a downloaded
  // installer against the publisherName baked into the *installed* app, so a
  // signed stable/RC rejects an unsigned dev installer and no future build can
  // fix the copies already out there. Dev builds carry no publisherName, so
  // everything leaving a dev channel — including the way back to stable — works.
  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual('rc', 'hourly')).toBe(true)
    expect(manual('stable', 'daily')).toBe(true)
    // Unparseable version: assume signed, which sends the user to a download
    // that works rather than an update that fails on a signature error.
    expect(manual(null, 'adhoc')).toBe(true)

    // Already unsigned — the updater skips verification entirely from here.
    expect(manual('adhoc', 'hourly')).toBe(false)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('adhoc', 'rc')).toBe(false)

    // Not a dev channel at all.
    expect(manual('stable', 'rc')).toBe(false)
    expect(manual('rc', 'stable')).toBe(false)
  })

  // Why: macOS dev builds are signed and notarized like a release, so the
  // updater installs them over a stable build with no manual step.
  it('never requires a manual install off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        requiresManualDevChannelInstall({
          platform,
          runningChannel: 'stable',
          targetChannel: 'adhoc'
        })
      ).toBe(false)
    }
  })

  it('detects an installable artifact from the platform update manifest', () => {
    expect(hasInstallableArtifactForPlatform('win32', ['latest.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('win32', ['latest-mac.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest-mac.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux-arm64.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('linux', [])).toBe(false)
    // An unknown platform must not hide every build; a download-time error is a
    // better failure than an empty picker with no explanation.
    expect(hasInstallableArtifactForPlatform('freebsd', [])).toBe(true)
  })

  it('finds the directly runnable installer for a platform', () => {
    const assets = [
      'latest.yml',
      'orca-windows-setup.exe',
      'orca-macos-arm64.dmg',
      'orca-linux.AppImage'
    ]
    expect(findInstallerAssetName('win32', assets)).toBe('orca-windows-setup.exe')
    expect(findInstallerAssetName('darwin', assets)).toBe('orca-macos-arm64.dmg')
    expect(findInstallerAssetName('linux', assets)).toBe('orca-linux.AppImage')
    expect(findInstallerAssetName('win32', ['latest.yml'])).toBeNull()
    expect(findInstallerAssetName('freebsd', assets)).toBeNull()
  })

  it('offers stable and rc on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(isChannelSupportedOnPlatform('stable', platform)).toBe(true)
      expect(isChannelSupportedOnPlatform('rc', platform)).toBe(true)
    }
  })

  it('accepts only known channels', () => {
    expect(isReleaseChannel('hourly')).toBe(true)
    expect(isReleaseChannel('daily')).toBe(true)
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

  // Why: an hourly is cut from main and must not read as newer than the stable it
  // is based on, or stable users would be offered it by an ordinary check.
  it('orders an hourly below its own stable release', () => {
    expect(compareAppVersions('1.4.160-hourly.202607281400', '1.4.160')).toBeLessThan(0)
  })

  it('orders a daily below its own stable release and below hourly of the same base', () => {
    expect(compareAppVersions('1.4.160-daily.202607281300', '1.4.160')).toBeLessThan(0)
    expect(
      compareAppVersions('1.4.160-daily.202607281300', '1.4.160-hourly.202607281400')
    ).toBeLessThan(0)
  })

  // Why adhoc sits at the very bottom: it is an unlanded branch, the least
  // trustworthy thing the updater can hand anyone. Every other channel of the
  // same base version must outrank it so no routine check ever selects one.
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
})
