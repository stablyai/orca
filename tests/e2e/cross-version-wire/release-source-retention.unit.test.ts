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
import { afterEach, expect, it, vi } from 'vitest'
import { CHECKOUT_FORMAT, type CheckoutLockOptions } from './release-checkout-publication'
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

it('keeps a copy lease alive beyond its stale interval and blocks competing cleanup', async () => {
  const root = await scratch()
  const options: CheckoutLockOptions = {
    realpath: false,
    stale: 2500,
    update: 1000,
    retries: { retries: 200, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: false }
  }
  let releaseCopy!: () => void
  let entered!: () => void
  const copying = new Promise<void>((resolve) => {
    releaseCopy = resolve
  })
  const enteredLease = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = withReleaseSourceLease(
    root,
    async () => {
      entered()
      await copying
    },
    options
  )
  await enteredLease
  const rivalEntered = vi.fn()
  const rival = withReleaseSourceLease(
    root,
    async () => {
      rivalEntered()
    },
    options
  )
  try {
    const start = Date.now()
    const mtimes = new Set<number>()
    await vi.waitFor(
      async () => {
        mtimes.add(
          (await stat(join(root, `format-${CHECKOUT_FORMAT}`, 'maintenance.lock'))).mtimeMs
        )
        expect(Date.now() - start).toBeGreaterThan(options.stale + 250)
        expect(mtimes.size).toBeGreaterThanOrEqual(3)
      },
      { timeout: 10_000, interval: 100 }
    )
    expect(rivalEntered).not.toHaveBeenCalled()
  } finally {
    releaseCopy()
    await Promise.allSettled([first, rival])
  }
  expect(rivalEntered).toHaveBeenCalledOnce()
}, 15_000)

it('releases the copy lease after an operation fails', async () => {
  const root = await scratch()
  await expect(
    withReleaseSourceLease(root, async () => {
      throw new Error('copy failed')
    })
  ).rejects.toThrow('copy failed')
  await expect(withReleaseSourceLease(root, async () => 'recovered')).resolves.toBe('recovered')
})
