import type { PluginSurface } from '../frames/plugin-protocol'
import {
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_HOST_API_1_8_SINCE } from './plugin-host-api-1-8'
import { PLUGIN_HOST_API_1_9_SINCE } from './plugin-host-api-1-9'
import { PLUGIN_HOST_API_1_10_SINCE } from './plugin-host-api-1-10'
import { PLUGIN_HOST_API_1_11_SINCE } from './plugin-host-api-1-11'
import { PLUGIN_HOST_API_1_7_SINCE } from './plugin-host-api-workspace-methods'
import { pluginHostMethodSinceFor, type PluginHostMethodSpec } from './plugin-host-method-spec'

/**
 * The first Orca release offering each Host API minor, indexed by minor. Why a table: authors
 * declare `engines.orca`, not a minor, so the validator needs the release a method arrived in.
 * Method floors use `since`/`framesSince`; `paramsSince` is ignored, as a param cannot be seen statically.
 * Minors 0–6 come from the release tags: the first `v1.4.*` whose method table had that minor.
 */
export const PLUGIN_HOST_API_MINOR_SINCE: readonly string[] = [
  PLUGIN_SCHEMA_SINCE_V1,
  '1.4.246',
  '1.4.246',
  '1.4.247',
  '1.4.251',
  '1.4.256',
  '1.4.257',
  PLUGIN_HOST_API_1_7_SINCE,
  PLUGIN_HOST_API_1_8_SINCE,
  PLUGIN_HOST_API_1_9_SINCE,
  PLUGIN_HOST_API_1_10_SINCE,
  PLUGIN_HOST_API_1_11_SINCE
]

/** `orca.host.has` arrived with manifest format 2; on older Orca a guard throws instead of answering. */
export const PLUGIN_HOST_HAS_SINCE = PLUGIN_MANIFEST_V2_SINCE

/** The oldest Orca whose surface offers the method; null for a minor this table does not know. */
export function pluginHostMethodRelease(
  entry: PluginHostMethodSpec,
  surface: PluginSurface
): string | null {
  return PLUGIN_HOST_API_MINOR_SINCE[pluginHostMethodSinceFor(entry, surface)] ?? null
}
