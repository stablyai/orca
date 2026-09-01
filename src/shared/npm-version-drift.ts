import { compareAppVersions } from './app-version'

export type NpmVersionDrift = 'same' | 'patch' | 'minor' | 'major' | 'prerelease' | 'unknown'

type ParsedSemverCore = {
  core: [number, number, number]
  hasPrerelease: boolean
}

/**
 * Local, minimal semver core+prerelease-presence parse. `app-version.ts`'s
 * `parseVersion` stays module-private (it is scoped to app-release semantics),
 * so this module keeps its own copy just for reading the triple that drives
 * severity classification.
 */
function parseSemverCore(value: string): ParsedSemverCore | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  )
  if (!match) {
    return null
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    hasPrerelease: Boolean(match[4])
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
  if (compareAppVersions(installed, latest) === 0) {
    return 'same'
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
