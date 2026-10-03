import { mkdirSync } from 'node:fs'
import {
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from './opencode-plugin-atomic-write'
import { join } from 'node:path'
import {
  isInstalledOpenCodePluginCurrent,
  isOverlayOpenCodePluginCurrent
} from './opencode-installed-plugin'

/**
 * Directory holding the TUI copy of a status plugin file. OpenCode 2 loads a
 * `tui` entrypoint only from a plugins/ subdirectory, and OpenCode 1 loads only
 * plugins/*.js files, so this entry is invisible to 1.x.
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
  const isCurrent =
    ownership === 'canonical' ? isInstalledOpenCodePluginCurrent : isOverlayOpenCodePluginCurrent
  if (isCurrent(entry, source)) {
    return
  }
  mkdirSync(dir, { recursive: true })
  const write =
    ownership === 'canonical'
      ? writeCanonicalOpenCodePluginAtomically
      : writeOverlayOpenCodePluginAtomically
  write(entry, source)
}
