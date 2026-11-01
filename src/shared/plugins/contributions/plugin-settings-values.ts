import type { PluginJsonValue } from '../workers/plugin-host-api'
import type { PluginSettingContribution } from './plugin-settings-contribution'

/** What declared settings read as before the person sets them. */
export function pluginSettingDefaults(
  settings: Iterable<PluginSettingContribution>
): Record<string, PluginJsonValue> {
  const defaults: Record<string, PluginJsonValue> = {}
  for (const setting of settings) {
    if (setting.default !== undefined) {
      defaults[setting.key] = setting.default
    }
  }
  return defaults
}
