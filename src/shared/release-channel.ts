import { compareAppVersions, isValidAppVersion } from './app-version'

export type ReleaseChannel = 'stable' | 'rc' | 'hourly' | 'adhoc'

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'rc', 'hourly', 'adhoc']

/** Dev builds live in their own repos so their tags never enter the main
 *  releases atom feed, which only exposes the 10 newest entries — 24 hourly
 *  tags a day would evict every stable/RC entry and strand real users. */
export const HOURLY_RELEASE_REPO = 'stablyai/orca-hourly'
export const ADHOC_RELEASE_REPO = 'stablyai/orca-adhoc'
export const MAIN_RELEASE_REPO = 'stablyai/orca'

export const HOURLY_PRERELEASE_IDENTIFIER = 'hourly'
export const ADHOC_PRERELEASE_IDENTIFIER = 'adhoc'

/** The dev channels, each published to its own repo rather than the main one. */
const DEDICATED_REPO_CHANNELS = ['hourly', 'adhoc'] as const

export type DedicatedRepoChannel = (typeof DEDICATED_REPO_CHANNELS)[number]

const CHANNEL_RELEASE_REPOS: Record<ReleaseChannel, string> = {
  stable: MAIN_RELEASE_REPO,
  rc: MAIN_RELEASE_REPO,
  hourly: HOURLY_RELEASE_REPO,
  adhoc: ADHOC_RELEASE_REPO
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === 'string' && RELEASE_CHANNELS.includes(value as ReleaseChannel)
}

/** True for channels published outside the main repo. The updater reports these
 *  as a distinct source so a pinned dev build is never mistaken for a release. */
export function hasDedicatedReleaseRepo(channel: ReleaseChannel): channel is DedicatedRepoChannel {
  return (DEDICATED_REPO_CHANNELS as readonly ReleaseChannel[]).includes(channel)
}

/**
 * Shared so the picker, the main-process check, and any future surface cannot
 * drift on where a channel is available.
 *
 * Why this rides on the dev-channel list: both dev channels are produced only by
 * macOS workflows, so neither has an artifact to offer elsewhere. If one ever
 * gains a Windows or Linux job, split the two concepts apart — they coincide
 * today, but "published to its own repo" and "built for macOS only" are not the
 * same claim.
 */
export function isChannelSupportedOnPlatform(
  channel: ReleaseChannel,
  platform: NodeJS.Platform
): boolean {
  return !hasDedicatedReleaseRepo(channel) || platform === 'darwin'
}

export function getReleaseRepoForChannel(channel: ReleaseChannel): string {
  return CHANNEL_RELEASE_REPOS[channel]
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

/** `1.4.160-hourly.202607281400` — a timestamp identifier keeps every build
 *  uniquely versioned so electron-updater never reads one as "same version". */
const HOURLY_VERSION = /^\d+\.\d+\.\d+-hourly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/**
 * `1.4.160-adhoc.20260728140533` — same idea, but stamped to the second.
 *
 * Why seconds here and not for hourly: hourly runs under a concurrency group, so
 * two of them can never be cut in the same minute. Adhoc builds are dispatched
 * on demand by whoever wants one, so two people cutting from different branches
 * at once is ordinary — and a minute-resolution stamp would collide on the tag
 * and fail the second build eight minutes in.
 */
const ADHOC_VERSION = /^\d+\.\d+\.\d+-adhoc\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

/**
 * Both patterns are anchored on the whole version: an unanchored tail match also
 * accepts garbage prefixes, so `not-a-version-hourly.202601010000` would parse.
 */
function parseStampedVersion(version: string, pattern: RegExp): Date | null {
  const match = normalizeTagToVersion(version).match(pattern)
  if (!match) {
    return null
  }
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Why the round-trip: Date.UTC silently rolls impossible dates forward, so a
  // corrupt `...hourly.202602300000` would render as March 2 rather than fail.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return null
  }
  return parsed
}

export function isHourlyVersion(version: string): boolean {
  return HOURLY_VERSION.test(normalizeTagToVersion(version))
}

export function isAdhocVersion(version: string): boolean {
  return ADHOC_VERSION.test(normalizeTagToVersion(version))
}

export function formatHourlyVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${HOURLY_PRERELEASE_IDENTIFIER}.${stamp}`
}

export function formatAdhocVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${ADHOC_PRERELEASE_IDENTIFIER}.${stamp}`
}

/** Returns the build's UTC timestamp, or null when the version isn't hourly. */
export function parseHourlyVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, HOURLY_VERSION)
}

/** Returns the build's UTC timestamp, or null when the version isn't adhoc. */
export function parseAdhocVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, ADHOC_VERSION)
}

/** The build's UTC timestamp for either dev channel, so a picker row can render
 *  a date without first working out which channel produced the version. */
export function parseDevBuildStamp(version: string): Date | null {
  return parseHourlyVersionStamp(version) ?? parseAdhocVersionStamp(version)
}

export function getVersionChannel(version: string): ReleaseChannel | null {
  const normalized = normalizeTagToVersion(version)
  if (!isValidAppVersion(normalized)) {
    return null
  }
  if (isHourlyVersion(normalized)) {
    return 'hourly'
  }
  if (isAdhocVersion(normalized)) {
    return 'adhoc'
  }
  // Why the dev channels are tested first: they are prereleases too, so this
  // catch-all would otherwise file every one of them under rc.
  return normalized.includes('-') ? 'rc' : 'stable'
}

/**
 * Release-notes page for a version, in whichever repo published it. Dev-channel
 * tags exist only in their own repo, so a main-repo tag URL for one 404s.
 * A null version falls back to the plain releases listing (not /releases/latest
 * — /latest also breaks when GitHub's API is degraded).
 */
export function getReleaseNotesUrlForVersion(version: string | null): string {
  const channel = version ? getVersionChannel(version) : null
  const repo = channel ? getReleaseRepoForChannel(channel) : MAIN_RELEASE_REPO
  return version
    ? `https://github.com/${repo}/releases/tag/v${normalizeTagToVersion(version)}`
    : `https://github.com/${repo}/releases`
}

export type ReleaseBuild = {
  tag: string
  version: string
  channel: ReleaseChannel
  /** The release's GitHub title. Null when it is absent or just repeats the tag,
   *  so the picker can tell "the workflow named this" from "nobody did". */
  name: string | null
  publishedAt: string | null
  releaseUrl: string
}

/** Newest first, so the picker's first row is always the channel's current tip. */
export function sortReleaseBuildsNewestFirst(builds: ReleaseBuild[]): ReleaseBuild[] {
  return [...builds].sort((left, right) => compareAppVersions(right.version, left.version))
}
