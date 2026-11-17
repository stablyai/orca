import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CHECKOUT_FORMAT } from './release-checkout-publication'
import {
  MAX_SHARED_RELEASE_SEEDS,
  pruneSharedReleaseSources,
  withReleaseSourceLease
} from './release-source-retention'
import { copySharedReleaseSource } from './release-source-cache'

const roots: string[] = []
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'orca-release-source-retention-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('caps seeds by recent use, preserves imported copies, and scopes cleanup to its format', async () => {
  const root = await scratch()
  const oldFormat = join(root, 'format-old', 'old-seed')
  await mkdir(oldFormat, { recursive: true })
  await withReleaseSourceLease(root, async (formatRoot, verify) => {
    const commits: string[] = []
    for (let index = 0; index < MAX_SHARED_RELEASE_SEEDS + 2; index += 1) {
      const commit = index.toString(16).padStart(40, '0')
      commits.push(commit)
      const seed = join(formatRoot, commit)
      await mkdir(seed)
      await writeFile(join(seed, 'source.ts'), 'export const release = true\n')
      await chmod(join(seed, 'source.ts'), 0o444)
      await utimes(seed, index + 1, index + 1)
    }
    const imported = join(root, 'already-imported')
    await copySharedReleaseSource(join(formatRoot, commits[1]), imported)
    const orphan = `.staging-${commits[1]}-format-${CHECKOUT_FORMAT}-abc123`
    await mkdir(join(formatRoot, orphan))
    await mkdir(join(formatRoot, '.staging-unrelated-live-owner'))
    await pruneSharedReleaseSources(formatRoot, commits[0], verify)
    const retained = (await readdir(formatRoot)).filter((name) => /^[\da-f]{40}$/.test(name))
    expect(retained).toHaveLength(MAX_SHARED_RELEASE_SEEDS)
    expect(retained).toContain(commits[0])
    expect(retained).not.toContain(commits[1])
    expect(retained).not.toContain(commits[2])
    expect(await readFile(join(imported, 'source.ts'), 'utf8')).toBe(
      'export const release = true\n'
    )
    expect((await stat(join(imported, 'source.ts'))).mode & 0o222).toBe(0)
    await expect(stat(join(formatRoot, orphan))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(formatRoot, '.staging-unrelated-live-owner'))).isDirectory()).toBe(true)
  })
  expect((await stat(oldFormat)).isDirectory()).toBe(true)
})

it('releases the copy lease after an operation fails', async () => {
  const root = await scratch()
  await expect(
    withReleaseSourceLease(root, async () => {
      throw new Error('copy failed')
    })
  ).rejects.toThrow('copy failed')
  await expect(withReleaseSourceLease(root, async () => 'recovered')).resolves.toBe('recovered')
})
