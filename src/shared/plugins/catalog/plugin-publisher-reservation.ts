// Why import-free: the community directory's indexer can vendor this file verbatim, so
// validate:plugin, install and the indexer reserve exactly the same names.

/** Publishers only Orca's official catalog may use, plus every name starting with `orca`. */
export const RESERVED_PLUGIN_PUBLISHERS: readonly string[] = [
  'stablyai',
  'official',
  'anthropic',
  'openai',
  'github'
]
export const RESERVED_PLUGIN_PUBLISHER_PREFIX = 'orca'

export function isReservedPluginPublisher(publisher: string): boolean {
  const name = publisher.toLowerCase()
  return (
    name.startsWith(RESERVED_PLUGIN_PUBLISHER_PREFIX) || RESERVED_PLUGIN_PUBLISHERS.includes(name)
  )
}
