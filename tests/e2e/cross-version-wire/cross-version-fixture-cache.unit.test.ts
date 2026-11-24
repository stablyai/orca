import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../src/shared/testing/remove-temp-dirs.test-support'
import {
  crossVersionFixtureCacheRoot,
  prepareCrossVersionFixtureCache
} from './cross-version-fixture-cache.ts'

const roots: string[] = []

afterEach(async () => {
  await removeTempDirs(roots.splice(0))
})

/** A checkout with dependencies, and a temp root beside it that other users share. */
async function checkoutBesideSharedTemp(): Promise<{ repoRoot: string; temporaryRoot: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orca-fixture-cache-')))
  roots.push(base)
  const repoRoot = join(base, 'checkout')
  await mkdir(join(repoRoot, 'node_modules'), { recursive: true })
  const temporaryRoot = join(base, 'tmp')
  await mkdir(temporaryRoot)
  return { repoRoot, temporaryRoot }
}

it('keeps the cache in a directory only its own user can write', async () => {
  const { repoRoot, temporaryRoot } = await checkoutBesideSharedTemp()

  const root = await prepareCrossVersionFixtureCache(repoRoot, temporaryRoot)

  expect(root).toBe(crossVersionFixtureCacheRoot(repoRoot, temporaryRoot))
  const namespace = dirname(root)
  expect((await lstat(namespace)).isSymbolicLink()).toBe(false)
  if (process.platform !== 'win32') {
    expect((await stat(namespace)).mode & 0o077).toBe(0)
  }
  expect(await realpath(join(root, 'node_modules'))).toBe(
    await realpath(join(repoRoot, 'node_modules'))
  )
  expect(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))).toEqual({
    extends: join(repoRoot, 'config', 'tsconfig.vitest-transform.json')
  })
})

// The checkout's own node_modules satisfies the identity check, so following the link would replace its tsconfig.
it.each(['namespace', 'cache root'])('refuses a %s that links to the checkout', async (level) => {
  const { repoRoot, temporaryRoot } = await checkoutBesideSharedTemp()
  const root = crossVersionFixtureCacheRoot(repoRoot, temporaryRoot)
  if (level === 'cache root') {
    await mkdir(dirname(root), { mode: 0o700 })
  }
  await symlink(
    repoRoot,
    level === 'cache root' ? root : dirname(root),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  await expect(prepareCrossVersionFixtureCache(repoRoot, temporaryRoot)).rejects.toThrow(
    'Cross-version fixture cache refused'
  )
  expect((await readdir(repoRoot)).toSorted()).toEqual(['node_modules'])
})

it.skipIf(process.platform === 'win32')(
  'refuses a cache namespace other users can write',
  async () => {
    const { repoRoot, temporaryRoot } = await checkoutBesideSharedTemp()
    const namespace = dirname(crossVersionFixtureCacheRoot(repoRoot, temporaryRoot))
    await mkdir(namespace)
    await chmod(namespace, 0o777)

    await expect(prepareCrossVersionFixtureCache(repoRoot, temporaryRoot)).rejects.toThrow(
      'Cross-version fixture cache refused'
    )
  }
)
