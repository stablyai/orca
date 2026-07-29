import { compareAppVersions, isValidAppVersion } from './app-version'

export type ReleaseChannel = 'stable' | 'rc' | 'hourly'

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'rc', 'hourly']

/** Hourly builds live in their own repo so their tags never enter the main
 *  releases atom feed, which only exposes the 10 newest entries — 24 hourly
 *  tags a day would evict every stable/RC entry and strand real users. */
export const HOURLY_RELEASE_REPO = 'stablyai/orca-hourly'
export const MAIN_RELEASE_REPO = 'stablyai/orca'

export const HOURLY_PRERELEASE_IDENTIFIER = 'hourly'

export function getReleaseRepoForChannel(channel: ReleaseChannel): string {
  return channel === 'hourly' ? HOURLY_RELEASE_REPO : MAIN_RELEASE_REPO
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

/** `1.4.160-hourly.202607281400` — a timestamp identifier keeps every build
 *  uniquely versioned so electron-updater never reads one as "same version". */
export function isHourlyVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-hourly\.\d{12}$/.test(normalizeTagToVersion(version))
}

export function formatHourlyVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${HOURLY_PRERELEASE_IDENTIFIER}.${stamp}`
}

/** Returns the build's UTC timestamp, or null when the version isn't hourly. */
export function parseHourlyVersionStamp(version: string): Date | null {
  const match = normalizeTagToVersion(version).match(
    /-hourly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/
  )
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute] = match
  const parsed = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  )
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function getVersionChannel(version: string): ReleaseChannel | null {
  const normalized = normalizeTagToVersion(version)
  if (!isValidAppVersion(normalized)) {
    return null
  }
  if (isHourlyVersion(normalized)) {
    return 'hourly'
  }
  return normalized.includes('-') ? 'rc' : 'stable'
}

export type ReleaseBuild = {
  tag: string
  version: string
  channel: ReleaseChannel
  publishedAt: string | null
  releaseUrl: string
}

/** Newest first, so the picker's first row is always the channel's current tip. */
export function sortReleaseBuildsNewestFirst(builds: ReleaseBuild[]): ReleaseBuild[] {
  return [...builds].sort((left, right) => compareAppVersions(right.version, left.version))
}
