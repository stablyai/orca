import { lstatSync } from 'node:fs'
import { nodeFileContentsEqualSync } from './node-file-content-equality'

// OpenCode 2 reloads this and subsequent plugins on mtime changes even for identical bytes; skip current writes.
// Follow canonical symlinks because OpenCode loads through them.
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
