import { isQualifiedPluginKey } from '../../plugins/frames/plugin-tab-key'

const PLUGIN_SENDER_PREFIX = 'plugin:'

/** The plugin a `plugin:<publisher>.<id>` sender address names; null for every other address. */
export function pluginSenderKey(address: string): string | null {
  if (!address.startsWith(PLUGIN_SENDER_PREFIX)) {
    return null
  }
  const key = address.slice(PLUGIN_SENDER_PREFIX.length)
  return isQualifiedPluginKey(key) ? key : null
}
