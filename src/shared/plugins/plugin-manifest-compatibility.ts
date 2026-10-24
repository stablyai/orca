import type { PluginCatalogRelease } from './plugin-catalog-release'
import { orcaEngineRangeSchema, satisfiesOrcaEngineRange } from './plugin-manifest'

/** Newest manifest format this build reads. */
export const PLUGIN_MANIFEST_VERSION_CURRENT = 2

/** Lenient pre-read of a manifest the strict schema rejected. A plugin built for a newer Orca
 *  fails on fields this build has never heard of; naming the version gap is the useful fix. */
export function pluginManifestCompatibilityError(raw: unknown, hostVersion: string): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const engines = 'engines' in raw ? raw.engines : undefined
  const range =
    typeof engines === 'object' && engines !== null && 'orca' in engines ? engines.orca : undefined
  if (
    orcaEngineRangeSchema.safeParse(range).success &&
    typeof range === 'string' &&
    !satisfiesOrcaEngineRange(hostVersion, range)
  ) {
    return `requires Orca ${range} (this is ${hostVersion})`
  }
  const version = 'manifestVersion' in raw ? raw.manifestVersion : undefined
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > PLUGIN_MANIFEST_VERSION_CURRENT
  ) {
    return `requires Orca support for manifest format ${version} (this is ${hostVersion})`
  }
  return null
}

/** Why before any download: a release for a newer Orca stays listed, but fetching bytes this
 *  build will refuse only delays the real answer. */
export function pluginCatalogReleaseCompatibilityError(
  release: PluginCatalogRelease,
  hostVersion: string
): string | null {
  return satisfiesOrcaEngineRange(hostVersion, `>=${release.minimumOrca}`)
    ? null
    : `requires Orca >=${release.minimumOrca} (this is ${hostVersion})`
}
