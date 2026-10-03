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
  GIT_OBJECT_QUARANTINE_DIR_PREFIX,
  inheritedObjectStore,
  type GitObjectQuarantineEnv
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

  it('points Git at a scratch dir inside objects/ and removes it afterwards', async () => {
    let seen: GitObjectQuarantineEnv | undefined

    await expect(
      createGitObjectQuarantine(resolveNative()).run(async (env) => {
        seen = env
        expect(scratchDirs()).toHaveLength(1)
        return 'ok'
      })
    ).resolves.toBe('ok')

    expect(seen).toEqual({
      GIT_OBJECT_DIRECTORY: expect.stringContaining(
        join(objects, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
      ),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects
    })
    expect(scratchDirs()).toEqual([])
  })

  it('removes the scratch dir when the command fails', async () => {
    const failure = new Error('merge-tree failed')

    await expect(
      createGitObjectQuarantine(resolveNative()).run(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(scratchDirs()).toEqual([])
  })

  it.each([
    ['the objects dir is unknown', async () => undefined],
    [
      'resolving the objects dir fails',
      async () => {
        throw new Error('x')
      }
    ],
    [
      'the scratch dir cannot be created',
      async () => ({ hostPath: '/no/such/objects', gitPath: '/no/such/objects' })
    ]
  ])('runs the command unquarantined when %s', async (_label, resolve) => {
    const command = vi.fn(async () => 'ok')

    await expect(createGitObjectQuarantine(resolve).run(command)).resolves.toBe('ok')

    expect(command).toHaveBeenCalledWith(undefined)
  })

  it('resolves the objects dir once and gives every run its own scratch dir', async () => {
    const resolve = vi.fn(resolveNative())
    const quarantine = createGitObjectQuarantine(resolve)
    const seen: (string | undefined)[] = []

    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))
    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the scratch dir in host spelling but hands WSL Git its Linux spelling', async () => {
    let seen: GitObjectQuarantineEnv | undefined

    await createGitObjectQuarantine(async () => ({
      hostPath: objects,
      gitPath: '/home/me/repo/.git/objects'
    })).run(async (env) => {
      seen = env
      expect(scratchDirs()).toHaveLength(1)
    })

    expect(seen?.GIT_OBJECT_DIRECTORY).toMatch(
      new RegExp(`^/home/me/repo/\\.git/objects/${GIT_OBJECT_QUARANTINE_DIR_PREFIX}\\w+$`)
    )
    expect(seen?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('/home/me/repo/.git/objects')
  })

  it.each([
    ['/plain/objects', '/plain/objects'],
    ['/odd:dir/objects', '"/odd:dir/objects"'],
    ['/quo"te\\dir/objects', '"/quo\\"te\\\\dir/objects"'],
    ['C:\\repo\\.git\\objects', 'C:\\repo\\.git\\objects'],
    ['C:\\a;b\\.git\\objects', '"C:\\\\a;b\\\\.git\\\\objects"']
  ])('spells alternates for %s so Git reads one entry', async (gitPath, expected) => {
    let seen: GitObjectQuarantineEnv | undefined

    await createGitObjectQuarantine(async () => ({ hostPath: objects, gitPath })).run(
      async (env) => {
        seen = env
      }
    )

    expect(seen?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(expected)
  })

  it.each([
    ['/repo/.git/objects', '/shared/objects:/more', '/shared/objects:/more:/repo/.git/objects'],
    ['C:\\repo\\.git\\objects', 'D:\\shared', 'D:\\shared;C:\\repo\\.git\\objects'],
    [
      '\\\\server\\share\\repo\\.git\\objects',
      '\\\\server\\shared',
      '\\\\server\\shared;\\\\server\\share\\repo\\.git\\objects'
    ]
  ])(
    'appends the real store to inherited alternates for %s, as Git’s own temporary stores do',
    async (gitPath, inheritedAlternates, expected) => {
      let seen: GitObjectQuarantineEnv | undefined

      await createGitObjectQuarantine(async () => ({
        hostPath: objects,
        gitPath,
        inheritedAlternates
      })).run(async (env) => {
        seen = env
      })

      expect(seen?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(expected)
    }
  )

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

  it('quarantines a store whose info/ holds no alternates file', async () => {
    writeFileSync(join(objects, 'info'), 'not a directory')
    const command = vi.fn(async () => 'ok')

    await createGitObjectQuarantine(resolveNative()).run(command)

    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ GIT_ALTERNATE_OBJECT_DIRECTORIES: objects })
    )
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

    // The index never lands without its pack.
    expect(readdirSync(join(objects, 'pack'))).toEqual([])
    expect(scratchDirs()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      '[git-object-quarantine] could not keep a fetched pack',
      expect.any(Error)
    )
  })
})

describe('inheritedObjectStore', () => {
  it('passes inherited alternates on, so the quarantine can append to them', () => {
    expect(inheritedObjectStore({ GIT_ALTERNATE_OBJECT_DIRECTORIES: '/shared' })).toEqual({
      inheritedAlternates: '/shared'
    })
    expect(inheritedObjectStore({})).toEqual({})
  })

  it('refuses an inherited object dir, which is the store Git reads and writes', () => {
    expect(inheritedObjectStore({ GIT_OBJECT_DIRECTORY: '/elsewhere/objects' })).toBeUndefined()
  })
})
