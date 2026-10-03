import { mkdirSync } from 'node:fs'
import {
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from './opencode-plugin-atomic-write'
import { dirname, join } from 'node:path'
import {
  InvalidOpenCodeTuiConfigError,
  registerOpenCodeTuiPlugin
} from './opencode-tui-config-registration'
import {
  isInstalledOpenCodePluginCurrent,
  isOverlayOpenCodePluginCurrent
} from './opencode-installed-plugin'

/**
 * Directory holding the TUI copy of a status plugin file. OpenCode 2 loads a
 * `tui` entrypoint from a plugins/ subdirectory; 1.x needs explicit config registration.
 */
export function openCodeTuiPluginDirName(pluginFileName: string): string {
  return `${pluginFileName.replace(/\.js$/, '')}-tui`
}

/**
 * Install the TUI copy beside the server plugin file. The same module serves
 * both: its setup() tells a TUI context from a server context. Call it before
 * writing the server file, which decides at load whether to stand down.
 */
export function writeOpenCodeTuiPlugin(
  pluginsDir: string,
  pluginFileName: string,
  source: string,
  ownership: 'canonical' | 'overlay' = 'canonical'
): void {
  const dir = join(pluginsDir, openCodeTuiPluginDirName(pluginFileName))
  const entry = join(dir, 'tui.js')
  // The 1.x TUI loader rejects a default object that also exposes server().
  const tuiSource =
    source.includes('const ORCA_STATUS_AGENT = "opencode";') &&
    source.includes('async function setupLegacyOpenCodeTui(')
      ? `${source.replace(/^export default /m, 'const orcaServerPlugin = ')}\nconst { server: _orcaServerOnly, ...orcaTuiPlugin } = orcaServerPlugin;\nexport default { id: ${JSON.stringify(pluginFileName.replace(/\.js$/, ''))}, setup: setupOpenCode2Status, ...orcaTuiPlugin, tui: setupLegacyOpenCodeTui };\n`
      : source
  const isCurrent =
    ownership === 'canonical' ? isInstalledOpenCodePluginCurrent : isOverlayOpenCodePluginCurrent
  if (isCurrent(entry, tuiSource)) {
    if (tuiSource !== source) {
      registerTuiPlugin(pluginsDir, entry, ownership)
    }
    return
  }
  mkdirSync(dir, { recursive: true })
  const write =
    ownership === 'canonical'
      ? writeCanonicalOpenCodePluginAtomically
      : writeOverlayOpenCodePluginAtomically
  write(entry, tuiSource)
  if (tuiSource !== source) {
    registerTuiPlugin(pluginsDir, entry, ownership)
  }
}

function registerTuiPlugin(
  pluginsDir: string,
  entry: string,
  ownership: 'canonical' | 'overlay'
): void {
  try {
    registerOpenCodeTuiPlugin(dirname(pluginsDir), entry, ownership)
  } catch (error) {
    if (!(error instanceof InvalidOpenCodeTuiConfigError)) {
      throw error
    }
    // Invalid TUI settings must not block the separate server status plugin.
    console.warn('[OpenCode] Failed to register TUI status plugin:', entry, error)
  }
}
