import { readPluginImageHeader } from '../images/plugin-image-format'
import {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileFormat
} from './plugin-panel-icon-format'
import { pluginPanelIconSvgError } from './plugin-panel-icon-svg'

export function pluginPanelIconFileError(path: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength > PLUGIN_PANEL_ICON_FILE_MAX_BYTES) {
    return `must be at most ${PLUGIN_PANEL_ICON_FILE_MAX_BYTES / 1024} KB`
  }
  const format = pluginPanelIconFileFormat(path)
  if (!format) {
    return 'must be an .svg or .png file'
  }
  if (format === 'png') {
    const info = readPluginImageHeader(bytes)
    return typeof info === 'string' ? info : info.format !== 'png' ? 'must be a PNG image' : null
  }
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return 'must be UTF-8 SVG text'
  }
  return pluginPanelIconSvgError(source)
}
