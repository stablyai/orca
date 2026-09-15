import { compareAppVersions } from './app-version'

export type NpmVersionDrift = 'same' | 'patch' | 'minor' | 'major' | 'prerelease' | 'unknown'

type ParsedSemverCore = {
  core: [number, number, number]
}

/** `0|[1-9]\d*` per the spec: a numeric identifier may not carry a leading zero, so
 *  `01.2.3` and `1.2.3-01` are not versions and must not compare `same` to themselves. */
const NUMERIC_IDENTIFIER = String.raw`0|[1-9]\d*`
const PRERELEASE_IDENTIFIER = String.raw`(?:${NUMERIC_IDENTIFIER}|\d*[A-Za-z-][0-9A-Za-z-]*)`
const SEMVER_CORE = String.raw`(${NUMERIC_IDENTIFIER})\.(${NUMERIC_IDENTIFIER})\.(${NUMERIC_IDENTIFIER})`
const SEMVER_PRERELEASE = String.raw`(?:-(${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*))?`
/** Build metadata takes any alphanumeric identifier; the leading-zero rule is numeric-only. */
const SEMVER_BUILD = String.raw`(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`
const SEMVER_PATTERN = new RegExp(`^${SEMVER_CORE}${SEMVER_PRERELEASE}${SEMVER_BUILD}$`)

/**
 * Local, minimal semver core+prerelease-presence parse. `app-version.ts`'s
 * `parseVersion` stays module-private (it is scoped to app-release semantics),
 * so this module keeps its own copy just for reading the triple that drives
 * severity classification.
 */
function parseSemverCore(value: string): ParsedSemverCore | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(SEMVER_PATTERN)
  if (!match) {
    return null
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])]
  }
}

/**
 * Classifies the outdated severity between an installed and a latest version
 * by the highest-order component that differs. Ordering (equality, and which
 * side is newer) delegates to `compareAppVersions`; only the per-component
 * triple used to pick major/minor/patch is parsed locally.
 */
export function classifyNpmVersionDrift(installed: string, latest: string): NpmVersionDrift {
  const installedCore = parseSemverCore(installed)
  const latestCore = parseSemverCore(latest)
  if (!installedCore || !latestCore) {
    return 'unknown'
  }
  const ordering = compareAppVersions(installed, latest)
  if (ordering === 0) {
    return 'same'
  }
  // Why: `latest` can lag what is installed — a next/prerelease install, a
  // linked local build, or a dist-tag that has not moved. Falling through to
  // the component diff would tell someone who is ahead that a major update
  // is available.
  if (ordering > 0) {
    return 'unknown'
  }

  const [installedMajor, installedMinor, installedPatch] = installedCore.core
  const [latestMajor, latestMinor, latestPatch] = latestCore.core
  if (installedMajor !== latestMajor) {
    return 'major'
  }
  if (installedMinor !== latestMinor) {
    return 'minor'
  }
  if (installedPatch !== latestPatch) {
    return 'patch'
  }
  return 'prerelease'
}
