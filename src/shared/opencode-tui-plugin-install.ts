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

/** OpenCode 2 loads plugins-subdirectory TUI entrypoints; v1 requires explicit config registration. */
export function openCodeTuiPluginDirName(pluginFileName: string): string {
  return `${pluginFileName.replace(/\.js$/, '')}-tui`
}

/** Install the dual-context TUI copy before the server file, whose load-time check decides whether to stand down. */
export function writeOpenCodeTuiPlugin(
  pluginsDir: string,
  pluginFileName: string,
  source: string,
  ownership: 'canonical' | 'overlay' = 'canonical'
): void {
  writeOpenCodeTuiPluginDirectory(
    pluginsDir,
    openCodeTuiPluginDirName(pluginFileName),
    source,
    ownership
  )
}

export function writeOpenCodeTuiPluginDirectory(
  pluginsDir: string,
  directoryName: string,
  source: string,
  ownership: 'canonical' | 'overlay' = 'canonical'
): void {
  const dir = join(pluginsDir, directoryName)
  const entry = join(dir, 'tui.js')
  // The 1.x TUI loader rejects a default object that also exposes server().
  const tuiSource =
    source.includes('const ORCA_STATUS_AGENT = "opencode";') &&
    source.includes('async function setupLegacyOpenCodeTui(')
      ? `${source.replace(/^export default /m, 'const orcaServerPlugin = ')}\nconst { server: _orcaServerOnly, ...orcaTuiPlugin } = orcaServerPlugin;\nexport default { id: ${JSON.stringify(directoryName.replace(/-tui$/, ''))}, setup: setupOpenCode2Status, ...orcaTuiPlugin, tui: setupLegacyOpenCodeTui };\n`
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
