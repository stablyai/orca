import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { materializeReleaseCheckout } from './release-checkout'
import {
  copySharedReleaseSource,
  populateFromSharedReleaseSource,
  resolveSharedReleaseCacheRoot
} from './release-source-cache'
import { CHECKOUT_FORMAT } from './release-checkout-publication'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps Windows copies independent and read-only after seed removal', async () => {
  const root = await scratch()
  const seed = join(root, 'seed')
  const copied = join(root, 'copy')
  await mkdir(seed)
  await writeFile(join(seed, 'source.ts'), 'released bytes\n')
  await chmod(join(seed, 'source.ts'), 0o444)
  await copySharedReleaseSource(seed, copied, 'win32')
  expect((await stat(join(copied, 'source.ts'))).ino).not.toBe(
    (await stat(join(seed, 'source.ts'))).ino
  )
  await rm(seed, { recursive: true, force: true })
  expect(await readFile(join(copied, 'source.ts'), 'utf8')).toBe('released bytes\n')
  expect((await stat(join(copied, 'source.ts'))).mode & 0o222).toBe(0)
})

it('keeps CI, isolated roots and the environment opt-out on local extraction', async () => {
  vi.stubEnv('CI', '')
  vi.stubEnv('ORCA_DISABLE_SHARED_RELEASE_CACHE', '')
  expect(
    await resolveSharedReleaseCacheRoot(process.cwd(), '/explicit-isolated-root')
  ).toBeUndefined()
  vi.stubEnv('CI', '1')
  expect(await resolveSharedReleaseCacheRoot(process.cwd())).toBeUndefined()
  vi.stubEnv('CI', '')
  vi.stubEnv('ORCA_DISABLE_SHARED_RELEASE_CACHE', '1')
  expect(await resolveSharedReleaseCacheRoot(process.cwd())).toBeUndefined()
  vi.stubEnv('ORCA_DISABLE_SHARED_RELEASE_CACHE', '')
  const folder = await scratch()
  expect(await resolveSharedReleaseCacheRoot(folder)).toBeUndefined()
})

it('resolves the default cache inside the execution repository common Git directory', async () => {
  vi.stubEnv('CI', '')
  vi.stubEnv('ORCA_DISABLE_SHARED_RELEASE_CACHE', '')
  const repo = await scratch()
  const result = await runProcess({
    program: 'git',
    args: ['init', '--quiet'],
    cwd: repo,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(result.code).toBe(0)
  expect(await resolveSharedReleaseCacheRoot(repo)).toBe(
    join(repo, '.git', 'orca-cache', 'release-source')
  )
})

it.each(['missing wire source', 'invalid imports metadata'])(
  'repairs a shared seed with %s',
  async (damage) => {
    const root = await scratch()
    const shared = join(root, 'shared')
    const commit = 'b'.repeat(40)
    const seed = join(shared, `format-${CHECKOUT_FORMAT}`, commit)
    await writeFile(join(root, 'package.json'), '{}')
    const extract = vi.fn(async (_repo: string, staging: string) => {
      await mkdir(join(staging, 'src', 'shared'), { recursive: true })
      await writeFile(join(staging, 'src', 'shared', 'terminal-stream-protocol.ts'), 'export {}\n')
      return new Map<string, Set<string>>()
    })
    const populate = async (name: string): Promise<void> => {
      const staging = join(root, name)
      await mkdir(staging)
      await populateFromSharedReleaseSource(root, staging, commit, shared, { extract })
    }
    await populate('first')
    if (damage === 'missing wire source') {
      await rm(join(seed, 'src', 'shared', 'terminal-stream-protocol.ts'))
    } else {
      const metadata = join(seed, 'release-package-imports.json')
      await chmod(metadata, 0o644)
      await writeFile(metadata, '[false]')
      await expect(populate('damaged')).rejects.toThrow('Invalid cached release package imports')
      await expect(stat(seed)).rejects.toThrow()
    }
    await populate('repaired')
    expect(extract).toHaveBeenCalledTimes(2)
    expect(
      await readFile(join(root, 'repaired', 'src', 'shared', 'terminal-stream-protocol.ts'), 'utf8')
    ).toBe('export {}\n')
  }
)

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-release-source-sharing-'))
  roots.push(root)
  return root
}

it('shares one published release source between separate local caches', async () => {
  const root = await scratch()
  const sharedCacheRoot = join(root, 'shared')
  const [a, b] = await Promise.all([
    materializeReleaseCheckout('v1.4.190', { cacheRoot: join(root, 'a'), sharedCacheRoot }),
    materializeReleaseCheckout('v1.4.190', { cacheRoot: join(root, 'b'), sharedCacheRoot })
  ])
  expect(a.root).not.toBe(b.root)
  expect(a.commit).toBe(b.commit)
  expect(await readdir(sharedCacheRoot)).toEqual([`format-${CHECKOUT_FORMAT}`])
  const source = join('src', 'shared', 'terminal-stream-protocol.ts')
  expect(await readFile(join(a.root, source), 'utf8')).toBe(
    await readFile(join(b.root, source), 'utf8')
  )
  const seed = join(sharedCacheRoot, `format-${CHECKOUT_FORMAT}`, a.commit)
  expect(await readFile(join(seed, source), 'utf8')).toBe(
    await readFile(join(a.root, source), 'utf8')
  )
  expect((await stat(join(b.root, source))).mode & 0o222).toBe(0)
  await rm(a.root, { recursive: true })
  expect(await readFile(join(b.root, source), 'utf8')).toBe(
    await readFile(join(seed, source), 'utf8')
  )
}, 120_000)

it('extracts locally when the optional shared cache cannot be created', async () => {
  const root = await scratch()
  const sharedCacheRoot = join(root, 'blocked-cache')
  await writeFile(sharedCacheRoot, 'occupied by a file')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const checkout = await materializeReleaseCheckout('v1.4.190', {
      cacheRoot: join(root, 'local'),
      sharedCacheRoot
    })
    expect(
      await readFile(join(checkout.root, 'src', 'shared', 'terminal-stream-protocol.ts'), 'utf8')
    ).toContain('export')
    expect(warning).toHaveBeenCalledTimes(1)
    expect(await readFile(sharedCacheRoot, 'utf8')).toBe('occupied by a file')
  } finally {
    warning.mockRestore()
  }
}, 120_000)

it('creates branch-dependent package stand-ins locally without changing the shared source', async () => {
  const root = await scratch()
  const shared = join(root, 'shared')
  const commit = 'a'.repeat(40)
  const seed = join(shared, `format-${CHECKOUT_FORMAT}`, commit)
  const extract = vi.fn(async (_repo: string, staging: string) => {
    await mkdir(join(staging, 'src', 'shared'), { recursive: true })
    await writeFile(join(staging, 'src', 'released.ts'), 'export const released = true\n')
    await writeFile(
      join(staging, 'src', 'shared', 'terminal-stream-protocol.ts'),
      'export const protocol = true\n'
    )
    return new Map([['missing-release-package', new Set(['oldExport'])]])
  })
  for (const declared of [false, true]) {
    const repo = join(root, declared ? 'declared' : 'removed')
    const staging = join(repo, 'staging')
    await mkdir(staging, { recursive: true })
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({
        dependencies: declared ? { 'missing-release-package': '1.0.0' } : {}
      })
    )
    await populateFromSharedReleaseSource(repo, staging, commit, shared, { extract })
    const stub = readFile(
      join(staging, 'node_modules', 'missing-release-package', 'stand-in-0.js'),
      'utf8'
    )
    if (declared) {
      await expect(stub).rejects.toThrow()
    } else {
      expect(await stub).toContain('oldExport')
    }
    await expect(readFile(join(staging, 'checkout-stamp.json'))).rejects.toThrow()
  }
  await expect(
    readFile(join(seed, 'node_modules', 'missing-release-package', 'stand-in-0.js'))
  ).rejects.toThrow()
  expect(JSON.parse(await readFile(join(seed, 'checkout-stamp.json'), 'utf8'))).toEqual({
    commit,
    format: CHECKOUT_FORMAT
  })
  expect(extract).toHaveBeenCalledTimes(1)
})
