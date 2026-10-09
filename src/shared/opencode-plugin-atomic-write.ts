import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { renameFileWithWindowsRetry } from './windows-retry-file-operations'

function isEnoentError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// Why: atomic rename on a dotfiles symlink replaces the link itself; resolving canonical target updates the real repo file.
export function resolveCanonicalPluginWritePath(pluginPath: string): string {
  try {
    const stat = lstatSync(pluginPath)
    if (!stat.isSymbolicLink()) {
      return pluginPath
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return pluginPath
    }
    throw error
  }

  // Why: realpathSync.native resolves canonical target when it exists;
  // if target is missing (dangling symlink), follow readlinkSync chain so the
  // target file is created at the intended destination and the symlink stays intact.
  try {
    return realpathSync.native(pluginPath)
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error
    }
  }

  const visited = new Set<string>([pluginPath])
  let current = pluginPath
  for (let depth = 0; depth < 40; depth++) {
    try {
      const link = readlinkSync(current)
      current = resolve(dirname(current), link)
      if (visited.has(current)) {
        throw new Error(`Symbolic link loop detected resolving "${pluginPath}"`)
      }
      visited.add(current)
      const nextStat = lstatSync(current)
      if (!nextStat.isSymbolicLink()) {
        return current
      }
    } catch (error) {
      if (isEnoentError(error)) {
        return current
      }
      throw error
    }
  }
  throw new Error(`Too many levels of symbolic links resolving "${pluginPath}"`)
}

// Why: write to sibling temp file and rename so concurrent reloads never observe a truncated or missing file.
function writeAtomicFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  let existingMode: number | undefined
  try {
    existingMode = statSync(targetPath).mode & 0o777
  } catch {
    // Target does not exist yet.
  }
  const tmpPath = join(dir, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: existingMode })
    if (existingMode !== undefined) {
      chmodSync(tmpPath, existingMode)
    }
    renameFileWithWindowsRetry(tmpPath, targetPath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

// Why: preserve dotfile symlinks at canonical paths by atomically replacing the real target file.
export function writeCanonicalOpenCodePluginAtomically(pluginPath: string, source: string): void {
  const targetPath = resolveCanonicalPluginWritePath(pluginPath)
  writeAtomicFile(targetPath, source)
}

// Why: replace any mirrored symlink directly in the overlay without following it to the user's config.
export function writeOverlayOpenCodePluginAtomically(pluginPath: string, source: string): void {
  writeAtomicFile(pluginPath, source)
}
