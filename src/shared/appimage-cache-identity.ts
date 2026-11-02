/**
 * How the AppImage extraction cache keys its copies, shared with the CLI: a service run from a copy
 * has no $APPIMAGE and must find, from the cache layout alone, which AppImage file it came from.
 * Layout: `<cache>/<namespace>/<generation>/`, namespace keyed on the AppImage path and generation
 * on that file's identity.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { APPIMAGE_NODE_RUNTIME_SEGMENTS } from './appimage-node-runtime'

const CACHE_KEY_PATTERN = /^[0-9a-f]{24}$/u
const LINUX_EXECUTABLE_NAME = 'orca-ide'
// Why a versioned key: builds before generation leases prune every generation in
// digest(appImagePath) except their own, including one a newer build still runs from. They never
// scan this namespace. Rolling back to such a build reopens that window for its own namespace only.
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

/**
 * Identity of the AppImage's *content*, used to key its extracted generation.
 *
 * Deliberately excludes ctime: it changes on any inode metadata write — `chmod +x` (which every
 * AppImage user is told to run), `chown`, an ACL or SELinux relabel, a backup restore — none of
 * which alter a byte of the payload. Including it re-keyed the cache on those, costing a full
 * ~519 MB re-extraction and a multi-second stall for nothing. An in-place content change moves
 * mtime and almost always size; a replacement moves the inode.
 */
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
