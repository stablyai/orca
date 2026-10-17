import type { PluginHostListEntry } from '../../../../preload/api-types'

type PluginPlatform = NonNullable<PluginHostListEntry['unsupportedPlatform']>['platforms'][number]

// Why untranslated: operating-system names are product names in every locale.
const PLUGIN_PLATFORM_LABELS: Record<PluginPlatform, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows'
}

export function pluginPlatformLabels(platforms: readonly PluginPlatform[]): string {
  return platforms.map((platform) => PLUGIN_PLATFORM_LABELS[platform]).join(', ')
}
