import { lstatSync } from 'node:fs'
import { nodeFileContentsEqualSync } from './node-file-content-equality'

// Why: OpenCode 2 reloads a plugin (and every plugin loaded after it) when its file's mtime changes,
// even with identical bytes, so installers must skip the write when Orca's plugin is already current.
// Follows symlinks: OpenCode 2 loads through them, so a linked file with Orca's bytes is current.
export function isInstalledOpenCodePluginCurrent(pluginPath: string, source: string): boolean {
  try {
    return nodeFileContentsEqualSync(pluginPath, source)
  } catch {
    return false
  }
}

// Overlay variant: a symlink there mirrors a user entry, never Orca's file, even when the bytes match.
export function isOverlayOpenCodePluginCurrent(pluginPath: string, source: string): boolean {
  try {
    return lstatSync(pluginPath).isFile() && nodeFileContentsEqualSync(pluginPath, source)
  } catch {
    return false
  }
}
