import { compareAppVersions, parseCliVersion } from '../app-version'

export type AgentVersionScheme = 'semver' | 'amp-build' | 'ignore-suffix'

export function parseAgentVersion(output: string): string | null {
  return parseCliVersion(output)
}

// Why: amp encodes its release as a monotonically increasing build number after `0.0.`.
function parseAmpBuild(version: string): number | null {
  const build = version.match(/^0\.0\.(\d+)/)?.[1]
  return build === undefined ? null : Number(build)
}

// Why: muse suffixes (-R<rev>.<n>) are build metadata, not ordering information.
function stripSuffix(version: string): string {
  return version.replace(/[-+].*$/, '')
}

export function isUpdateAvailable(
  current: string | null,
  latest: string | null,
  scheme: AgentVersionScheme
): boolean {
  if (current === null || latest === null) {
    return false
  }
  if (scheme === 'amp-build') {
    const currentBuild = parseAmpBuild(current)
    const latestBuild = parseAmpBuild(latest)
    return currentBuild !== null && latestBuild !== null && latestBuild > currentBuild
  }
  if (scheme === 'ignore-suffix') {
    return compareAppVersions(stripSuffix(latest), stripSuffix(current)) > 0
  }
  return compareAppVersions(latest, current) > 0
}
