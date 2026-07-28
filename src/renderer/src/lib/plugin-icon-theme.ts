import type {
  PluginIconThemeImage,
  PluginIconThemeRegistration,
  PLUGIN_ICON_THEME_SLOTS
} from '../../../shared/plugins/plugin-icon-theme-artifact'

export type PluginIconThemeSlot = (typeof PLUGIN_ICON_THEME_SLOTS)[number]

export function isPluginIconThemeImage(value: unknown): value is PluginIconThemeImage {
  // Why: plugin SVGs are renderer data, never markup. Refuse unexpected IPC
  // values so consumers only render the host-sanitized image representation.
  return (
    typeof value === 'object' &&
    value !== null &&
    'dataUrl' in value &&
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:image/svg+xml;base64,') &&
    'rendering' in value &&
    (value.rendering === 'image' || value.rendering === 'mask')
  )
}

export function getPluginIconSlotImage(
  theme: PluginIconThemeRegistration | null | undefined,
  slot: PluginIconThemeSlot
): PluginIconThemeImage | null {
  const image = theme?.icons[slot]
  return isPluginIconThemeImage(image) ? image : null
}
