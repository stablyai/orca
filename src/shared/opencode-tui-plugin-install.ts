import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInstalledOpenCodePluginCurrent } from './opencode-installed-plugin'

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
  source: string
): void {
  const dir = join(pluginsDir, openCodeTuiPluginDirName(pluginFileName))
  const entry = join(dir, 'tui.js')
  if (isInstalledOpenCodePluginCurrent(entry, source)) {
    return
  }
  mkdirSync(dir, { recursive: true })
  try {
    unlinkSync(entry)
  } catch {
    // First install, or nothing to replace.
  }
  writeFileSync(entry, source)
}
