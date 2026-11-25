/** Find copies without APPIMAGE via cache/namespace/generation: namespace identifies the source path, generation its file identity. Share this layout with the CLI. */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { APPIMAGE_NODE_RUNTIME_SEGMENTS } from './appimage-node-runtime'

const CACHE_KEY_PATTERN = /^[0-9a-f]{24}$/u
const LINUX_EXECUTABLE_NAME = 'orca-ide'
// Version the namespace so older pruners cannot delete generations a newer build still runs; rollback reopens only the old namespace's risk.
const NAMESPACE_KEY_VERSION = 'generation-lease-v1'
/** Beside a namespace's generations; not a cache key, so pruning skips it. */
export const APPIMAGE_SOURCE_RECORD_NAME = 'source-appimage'

export function appImageCacheDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function isAppImageCacheKey(value: string): boolean {
  return CACHE_KEY_PATTERN.test(value)
}

export function appImageNamespaceKey(appImagePath: string): string {
  return appImageCacheDigest(`${NAMESPACE_KEY_VERSION}\0${appImagePath}`)
}

/** Exclude ctime: chmod/chown/ACL/relabel/restore changes metadata without changing payload and would force ~519MB re-extraction. Content changes move mtime/usually size; replacement changes inode. */
export function resolveAppImageCacheKey(appImagePath: string): string | null {
  try {
    const stats = statSync(appImagePath)
    return appImageCacheDigest(`${stats.dev}\0${stats.ino}\0${stats.size}\0${stats.mtimeMs}`)
  } catch {
    return null
  }
}

export type AppImageGenerationLocation = {
  cacheRootPath: string
  namespaceKey: string
  generationKey: string
  rootPath: string
}

/** The generation root an executable runs from: its `orca-ide`, or its bundled Node (the daemon). */
function generationRootOfExecutable(execPath: string): string | null {
  const resolved = resolve(execPath)
  if (basename(resolved) === LINUX_EXECUTABLE_NAME) {
    return dirname(resolved)
  }
  const nodeSuffix = join('resources', ...APPIMAGE_NODE_RUNTIME_SEGMENTS)
  return resolved.endsWith(`${sep}${nodeSuffix}`) ? resolved.slice(0, -nodeSuffix.length - 1) : null
}

export function resolveAppImageGenerationOfExecutable(
  execPath: string
): AppImageGenerationLocation | null {
  const rootPath = generationRootOfExecutable(execPath)
  if (!rootPath) {
    return null
  }
  const namespacePath = dirname(rootPath)
  const generationKey = basename(rootPath)
  const namespaceKey = basename(namespacePath)
  if (!isAppImageCacheKey(generationKey) || !isAppImageCacheKey(namespaceKey)) {
    return null
  }
  return { cacheRootPath: dirname(namespacePath), namespaceKey, generationKey, rootPath }
}

/** The AppImage file `namespaceKey` was extracted from, when its record still matches the key. */
export function readAppImageSourceOfNamespace(
  cacheRootPath: string,
  namespaceKey: string
): string | null {
  try {
    const appImagePath = readFileSync(
      join(resolve(cacheRootPath), namespaceKey, APPIMAGE_SOURCE_RECORD_NAME),
      'utf8'
    )
    return isAbsolute(appImagePath) && appImageNamespaceKey(appImagePath) === namespaceKey
      ? appImagePath
      : null
  } catch {
    return null
  }
}
