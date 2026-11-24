import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The temp root may be shared with other users, so the cache lives in a namespace only its own user can write. */
function cacheNamespace(): string {
  const uid = process.platform === 'win32' ? undefined : process.getuid?.()
  return uid === undefined ? 'orca-cross-version-checkouts' : `orca-cross-version-checkouts-${uid}`
}

export function crossVersionFixtureCacheRoot(repoRoot: string, temporaryRoot: string): string {
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)
  return join(temporaryRoot, cacheNamespace(), key)
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/** One level of the cache path, created as this user's alone. A link, or a directory another user
 *  owns or can write, would let that user choose where the cache writes, so it is refused instead. */
async function claimCacheDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
    return
  } catch (error) {
    if (!alreadyExists(error)) {
      throw error
    }
  }
  const stats = await lstat(path)
  const uid = process.platform === 'win32' ? undefined : process.getuid?.()
  if (
    !stats.isDirectory() ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(
      `Cross-version fixture cache refused ${path}: it is a link, another user's directory, or writable by others`
    )
  }
}

export async function prepareCrossVersionFixtureCache(
  repoRoot: string,
  temporaryRoot?: string
): Promise<string> {
  const base = temporaryRoot ?? (await realpath(tmpdir()))
  const root = crossVersionFixtureCacheRoot(repoRoot, base)
  await claimCacheDirectory(join(base, cacheNamespace()))
  await claimCacheDirectory(root)
  const dependencies = join(repoRoot, 'node_modules')
  const linkedDependencies = join(root, 'node_modules')
  try {
    await symlink(
      dependencies,
      linkedDependencies,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  } catch (error) {
    if (!alreadyExists(error)) {
      throw error
    }
    if ((await realpath(linkedDependencies)) !== (await realpath(dependencies))) {
      throw new Error('Cross-version fixture cache has a different dependency installation')
    }
  }
  const config = join(root, 'tsconfig.json')
  const staged = `${config}.${randomUUID()}.tmp`
  try {
    await writeFile(
      staged,
      JSON.stringify({ extends: join(repoRoot, 'config', 'tsconfig.vitest-transform.json') })
    )
    await rename(staged, config)
  } finally {
    await rm(staged, { force: true })
  }
  return root
}
