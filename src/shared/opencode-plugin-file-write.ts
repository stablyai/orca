import { randomUUID } from 'node:crypto'
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export type OpenCodePluginLinkPolicy = 'write-through-link' | 'replace-link'

// Why: OpenCode 2 reloads a plugin on mtime change, so a reader must never see the file missing or truncated.
// 'write-through-link' keeps a dotfile-manager symlink intact; 'replace-link' swaps out a mirrored user entry.
export function writeOpenCodePluginFile(
  pluginPath: string,
  source: string,
  linkPolicy: OpenCodePluginLinkPolicy
): void {
  const targetPath =
    linkPolicy === 'write-through-link' ? resolveLinkTarget(pluginPath) : pluginPath
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, source)
    renameSync(tmpPath, targetPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    if (process.platform !== 'win32') {
      throw error
    }
    // Why: Windows refuses to rename over a file another process holds open.
    writeFileSync(targetPath, source)
  }
}

function resolveLinkTarget(pluginPath: string): string {
  try {
    return realpathSync(pluginPath)
  } catch {
    return pluginPath
  }
}
