import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX
} from './git-object-quarantine'

const { failedRenameTargets, renamedTargets } = vi.hoisted(() => {
  const renamedTargets: string[] = []
  return { failedRenameTargets: new Set<string>(), renamedTargets }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failedRenameTargets.has(basename(to))) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      await actual.rename(from, to)
      renamedTargets.push(basename(to))
    }
  }
})

describe('createGitObjectQuarantine', () => {
  let root: string
  let objects: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-object-quarantine-'))
    objects = join(root, 'objects')
    mkdirSync(join(objects, 'pack'), { recursive: true })
  })

  afterEach(() => {
    failedRenameTargets.clear()
    renamedTargets.length = 0
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  const resolveNative = () => async () => ({ hostPath: objects, gitPath: objects })
  const scratchDirs = (): string[] =>
    readdirSync(objects).filter((entry) => entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX))

  it.each([
    ['has an alternates file', (info: string) => writeFileSync(join(info, 'alternates'), '')],
    [
      'has an alternates file this process cannot inspect',
      (info: string) => {
        writeFileSync(join(info, 'alternates'), '/elsewhere/objects\n')
        chmodSync(info, 0o000)
      }
    ]
  ])('runs unquarantined when the real store %s', async (_label, prepare) => {
    const info = join(objects, 'info')
    mkdirSync(info)
    prepare(info)
    const command = vi.fn(async () => 'ok')

    try {
      await expect(createGitObjectQuarantine(resolveNative()).run(command)).resolves.toBe('ok')
    } finally {
      chmodSync(info, 0o755)
    }

    expect(command).toHaveBeenCalledWith(undefined)
    expect(scratchDirs()).toEqual([])
  })

  it('moves packs Git fetched into the scratch dir to the real store, index last', async () => {
    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      for (const file of ['pack-abc1.idx', 'pack-abc1.pack', 'pack-abc1.promisor']) {
        writeFileSync(join(scratchPack, file), file)
      }
      // A pack without its index is invisible to Git, so moving it is harmless.
      writeFileSync(join(scratchPack, 'pack-def2.pack'), 'partial')
      writeFileSync(join(scratchPack, 'tmp_pack_XYZ'), 'partial')
      mkdirSync(join(env?.GIT_OBJECT_DIRECTORY ?? '', 'ab'))
      writeFileSync(join(env?.GIT_OBJECT_DIRECTORY ?? '', 'ab', 'cdef'), 'merge-tree output')
    })

    expect(readdirSync(join(objects, 'pack')).sort()).toEqual([
      'pack-abc1.idx',
      'pack-abc1.pack',
      'pack-abc1.promisor',
      'pack-def2.pack'
    ])
    expect(renamedTargets.at(-1)).toBe('pack-abc1.idx')
    expect(existsSync(join(objects, 'ab'))).toBe(false)
    expect(scratchDirs()).toEqual([])
  })

  it('leaves a pack the real store already has untouched', async () => {
    writeFileSync(join(objects, 'pack', 'pack-abc1.pack'), 'installed')
    writeFileSync(join(objects, 'pack', 'pack-abc1.idx'), 'installed')

    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      writeFileSync(join(scratchPack, 'pack-abc1.pack'), 'refetched')
      writeFileSync(join(scratchPack, 'pack-abc1.idx'), 'refetched')
    })

    expect(readFileSync(join(objects, 'pack', 'pack-abc1.pack'), 'utf8')).toBe('installed')
    expect(readFileSync(join(objects, 'pack', 'pack-abc1.idx'), 'utf8')).toBe('installed')
  })

  it('stops at a failed pack move, still removing the scratch dir and returning the result', async () => {
    failedRenameTargets.add('pack-abc1.pack')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      createGitObjectQuarantine(resolveNative()).run(async (env) => {
        const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
        mkdirSync(scratchPack)
        for (const file of ['pack-abc1.idx', 'pack-abc1.pack']) {
          writeFileSync(join(scratchPack, file), file)
        }
        return 'ok'
      })
    ).resolves.toBe('ok')

    expect(readdirSync(join(objects, 'pack'))).toEqual([])
    expect(scratchDirs()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      '[git-object-quarantine] could not keep a fetched pack',
      expect.any(Error)
    )
  })
})
