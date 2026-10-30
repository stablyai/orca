/** First release that read plugins: manifest v1, its first seven contribution points, every
 *  capability, event and built-in command action of that era. */
export const PLUGIN_SCHEMA_SINCE_V1 = '1.4.160'
/** First release planned to read manifest v2, the v2 catalog and their new fields. */
export const PLUGIN_MANIFEST_V2_SINCE = '1.4.245'

type PluginFieldDoc = {
  description: string
  'x-orca-since': string
  examples?: unknown[]
}

// Why one suffix: these rules are enforced at runtime only (a pattern cannot express them), so
// every path field states them where an editor shows the field.
const PATH_RUNTIME_RULES =
  'Relative to the plugin root; `..` segments and Windows device names such as `CON` are refused.'

/** pluginFieldDoc for a plugin-relative path field. */
export function pluginPathFieldDoc(
  description: string,
  since: string,
  examples?: readonly unknown[]
): PluginFieldDoc {
  return pluginFieldDoc(`${description} ${PATH_RUNTIME_RULES}`, since, examples)
}

/** Metadata the published JSON Schema and the author reference render for one field. */
export function pluginFieldDoc(
  description: string,
  since: string,
  examples?: readonly unknown[]
): PluginFieldDoc {
  return examples
    ? { description, 'x-orca-since': since, examples: [...examples] }
    : { description, 'x-orca-since': since }
}
