import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type OpenCodePluginLinkPolicy = 'write-through-link' | 'replace-link'

const MAX_LINK_HOPS = 40

// Why: OpenCode 2 reloads a plugin on mtime change, so a reader must never see the file missing or truncated.
// 'write-through-link' keeps a dotfile-manager symlink intact; 'replace-link' swaps out a mirrored user entry.
export function writeOpenCodePluginFile(
  pluginPath: string,
  source: string,
  linkPolicy: OpenCodePluginLinkPolicy
): void {
  const targetPath =
    linkPolicy === 'write-through-link' ? resolveLinkTarget(pluginPath) : pluginPath
  const existingMode = readRegularFileMode(targetPath)
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, source)
    if (existingMode !== null) {
      chmodSync(tmpPath, existingMode)
    }
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
  try {
    renameSync(tmpPath, targetPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    // Why: Windows refuses to rename over a file another process holds open; never write through a link we were asked to replace.
    if (process.platform !== 'win32' || existingMode === null) {
      throw error
    }
    writeFileSync(targetPath, source)
  }
}

// Why: realpath throws on a dangling link, but the link's destination is still where the dotfile manager expects the file.
function resolveLinkTarget(pluginPath: string): string {
  let current = pluginPath
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    try {
      if (!lstatSync(current).isSymbolicLink()) {
        return current
      }
      current = resolve(dirname(current), readlinkSync(current))
    } catch {
      return current
    }
  }
  return current
}

function readRegularFileMode(path: string): number | null {
  try {
    const stats = lstatSync(path)
    return stats.isFile() ? stats.mode & 0o777 : null
  } catch {
    return null
  }
}
