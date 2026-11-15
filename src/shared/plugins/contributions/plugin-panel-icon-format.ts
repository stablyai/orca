export type PluginPanelIconFileFormat = 'svg' | 'png'

/** Both formats share one bound: a 16–24 px panel glyph never needs large artwork. */
export const PLUGIN_PANEL_ICON_FILE_MAX_BYTES = 32 * 1024

const PANEL_ICON_FILE_EXTENSION = /\.(svg|png)$/i

export function pluginPanelIconFileFormat(path: string): PluginPanelIconFileFormat | null {
  const extension = PANEL_ICON_FILE_EXTENSION.exec(path)?.[1]?.toLowerCase()
  return extension === 'svg' || extension === 'png' ? extension : null
}
