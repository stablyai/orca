import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import {
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'

/** The newest "since" this build's schemas cite: everything up to it is readable here. */
export const PLUGIN_SCHEMA_NEWEST_SINCE = [PLUGIN_SCHEMA_SINCE_V1, PLUGIN_MANIFEST_V2_SINCE].reduce(
  (newest, version) => (satisfiesOrcaEngineRange(version, `>=${newest}`) ? version : newest)
)

/**
 * The version plugins are gated against. Why not the app version alone: development and local
 * builds keep the package version of the last version bump while already reading every field
 * their schemas define, so a plugin correctly declaring `>=<newest since>` would be refused by
 * the build that introduced the field. Releases are at or past that version, so this changes
 * nothing for them.
 */
export function pluginHostVersion(appVersion: string): string {
  return satisfiesOrcaEngineRange(appVersion, `>=${PLUGIN_SCHEMA_NEWEST_SINCE}`)
    ? appVersion
    : PLUGIN_SCHEMA_NEWEST_SINCE
}
