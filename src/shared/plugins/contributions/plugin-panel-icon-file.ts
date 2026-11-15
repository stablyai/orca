import { pluginPanelIconSvgError } from './plugin-panel-icon-svg'

export const PLUGIN_PANEL_ICON_FILE_MAX_BYTES = 32 * 1024
export const PLUGIN_PANEL_ICON_FILE_EXTENSION = /\.svg$/

export function isPluginPanelIconFilePath(path: string): boolean {
  return PLUGIN_PANEL_ICON_FILE_EXTENSION.test(path)
}

export function pluginPanelIconFileError(path: string, bytes: Uint8Array): string | null {
  if (!isPluginPanelIconFilePath(path)) {
    return 'must be an .svg file'
  }
  if (bytes.byteLength > PLUGIN_PANEL_ICON_FILE_MAX_BYTES) {
    return `must be at most ${PLUGIN_PANEL_ICON_FILE_MAX_BYTES / 1024} KB`
  }
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return 'must be UTF-8 SVG text'
  }
  return pluginPanelIconSvgError(source)
}
