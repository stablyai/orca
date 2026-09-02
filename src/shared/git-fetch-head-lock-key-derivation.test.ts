import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as path from 'node:path'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  runWithGitOperationLock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  realpath: mocks.realpath,
  stat: mocks.stat
}))
vi.mock('./git-operation-lock', () => ({
  runWithGitOperationLock: mocks.runWithGitOperationLock
}))

import { runWithGitFetchHeadLock } from './git-fetch-head-lock'

const GIT_DIR_ENTRY = { isDirectory: () => true, isFile: () => false }
const GIT_FILE_ENTRY = { isDirectory: () => false, isFile: () => true }

function lockKeys(): string[] {
  return mocks.runWithGitOperationLock.mock.calls.map(([key]) => key as string)
}

/**
 * An on-disk layout keyed by forward-slash spelling: a `gitdir:` payload or `commondir` body for
 * every file that exists, and `null` for a `.git` directory. Anything absent throws, so a key
 * derived from a path that exists nowhere cannot silently read a sibling's metadata.
 */
function mockLayout(entries: Record<string, string | null>): void {
  const spell = (target: unknown): string => String(target).replaceAll('\\', '/')
  mocks.stat.mockImplementation(async (target: string) => {
    const entry = entries[spell(target)]
    if (entry === undefined) {
      throw new Error(`ENOENT ${spell(target)}`)
    }
    return entry === null ? GIT_DIR_ENTRY : GIT_FILE_ENTRY
  })
  mocks.readFile.mockImplementation(async (target: string) => {
    const entry = entries[spell(target)]
    if (!entry) {
      throw new Error(`ENOENT ${spell(target)}`)
    }
    return entry
  })
}

describe('FETCH_HEAD lock key derivation', () => {
  let platformSpy: MockInstance<() => NodeJS.Platform> | undefined

  const usePlatform = (platform: NodeJS.Platform): void => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  }

  beforeEach(() => {
    mocks.readFile.mockReset().mockRejectedValue(new Error('no metadata file'))
    // Identity realpath: the paths under test are already canonical on their host.
    mocks.realpath.mockReset().mockImplementation(async (target: string) => target)
    mocks.stat.mockReset().mockResolvedValue(GIT_DIR_ENTRY)
    mocks.runWithGitOperationLock
      .mockReset()
      .mockImplementation(async (_key, _signal, run) => run())
  })

  afterEach(() => {
    platformSpy?.mockRestore()
    platformSpy = undefined
  })

  it('folds the WSL UNC aliases and distro casing of one repo into a single lock key', async () => {
    usePlatform('win32')

    await runWithGitFetchHeadLock(String.raw`\\wsl$\Ubuntu\home\me\repo`, undefined, async () => 0)
    await runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\ubuntu\home\me\repo`,
      undefined,
      async () => 0
    )

    expect(lockKeys()).toEqual([
      '//wsl.localhost/ubuntu/home/me/repo/.git/FETCH_HEAD',
      '//wsl.localhost/ubuntu/home/me/repo/.git/FETCH_HEAD'
    ])
  })

  it('leaves the two UNC spellings apart on a non-Windows host', async () => {
    usePlatform('darwin')

    await runWithGitFetchHeadLock(String.raw`\\wsl$\Ubuntu\home\me\repo`, undefined, async () => 0)
    await runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\ubuntu\home\me\repo`,
      undefined,
      async () => 0
    )

    const keys = lockKeys()
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toBe(path.join(String.raw`\\wsl$\Ubuntu\home\me\repo`, '.git', 'FETCH_HEAD'))
  })

  it('puts a padded gitfile pointer in the same lane as its bare spelling', async () => {
    usePlatform('darwin')
    mocks.stat.mockResolvedValue(GIT_FILE_ENTRY)
    const gitfile = (payload: string): void => {
      mocks.readFile.mockImplementation(async (target: string) => {
        if (String(target).endsWith('commondir')) {
          throw new Error('no commondir')
        }
        return `gitdir:${payload}\n`
      })
    }

    gitfile(' ../repo/.git/worktrees/wt')
    await runWithGitFetchHeadLock('/work/wt', undefined, async () => 0)
    // git's own read_gitfile_gently strips the padding, so both spellings name one repo.
    gitfile('\t../repo/.git/worktrees/wt  ')
    await runWithGitFetchHeadLock('/work/wt', undefined, async () => 0)

    const keys = lockKeys()
    expect(keys[0]).toBe(path.join('/work/repo/.git/worktrees/wt', 'FETCH_HEAD'))
    expect(keys[1]).toBe(keys[0])
  })

  it("keeps a drive-spelled worktree on its own main checkout's lane", async () => {
    usePlatform('win32')
    mockLayout({
      'C:/repo/.git': null,
      'C:/workspace/wt-a/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt-a\n',
      'C:/workspace/wt-b/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt-b\n',
      'C:/repo/.git/worktrees/wt-a/commondir': '../..\n',
      'C:/repo/.git/worktrees/wt-b/commondir': '../..\n'
    })

    await runWithGitFetchHeadLock(String.raw`C:\repo`, undefined, async () => 0)
    await runWithGitFetchHeadLock(String.raw`C:\workspace\wt-a`, undefined, async () => 0)
    await runWithGitFetchHeadLock(String.raw`C:\workspace\wt-b`, undefined, async () => 0)

    // The drvfs prefix must be gone: `C:\mnt\c\repo` exists nowhere, so it dead-ends the walk and
    // strands each worktree away from the main checkout it shares FETCH_HEAD with.
    expect(lockKeys()).toEqual(Array(3).fill(String.raw`C:\repo\.git\FETCH_HEAD`))
  })

  it('keeps a WSL UNC repo and its linked worktree on one lane', async () => {
    usePlatform('win32')
    mockLayout({
      '//wsl.localhost/Ubuntu/mnt/c/repo/.git': null,
      '//wsl$/ubuntu/home/me/wt/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt\n',
      '//wsl$/ubuntu/mnt/c/repo/.git/worktrees/wt/commondir': '../..\n'
    })

    // A main worktree's `.git` is a directory, so no pointer is translated and its key stays on the
    // UNC spelling. Translating the linked worktree's pointer to `C:\...` would split the repo.
    await runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\Ubuntu\mnt\c\repo`,
      undefined,
      async () => 0
    )
    await runWithGitFetchHeadLock(String.raw`\\wsl$\ubuntu\home\me\wt`, undefined, async () => 0)

    expect(lockKeys()).toEqual(Array(2).fill('//wsl.localhost/ubuntu/mnt/c/repo/.git/fetch_head'))
  })

  it("merges an absolute guest commondir into the main checkout's lane", async () => {
    usePlatform('win32')
    mockLayout({
      'C:/repo/.git': null,
      'C:/workspace/wt/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt\n',
      // git may spell commondir absolutely; written by git-in-WSL it is a guest path.
      'C:/repo/.git/worktrees/wt/commondir': '/mnt/c/repo/.git\n'
    })

    await runWithGitFetchHeadLock(String.raw`C:\repo`, undefined, async () => 0)
    await runWithGitFetchHeadLock(String.raw`C:\workspace\wt`, undefined, async () => 0)

    expect(lockKeys()).toEqual(Array(2).fill(String.raw`C:\repo\.git\FETCH_HEAD`))
  })

  it('walks to the drive root with Windows rules for a folder workspace', async () => {
    usePlatform('win32')
    mockLayout({})

    await runWithGitFetchHeadLock(String.raw`C:\notes\inbox`, undefined, async () => 0)

    // Nothing up the tree is a repo, so the walk must terminate at the drive root the way Windows
    // spells it - not at a POSIX `.` that would put every folder workspace on one lane.
    expect(lockKeys()[0]).toBe(String.raw`C:\.git\FETCH_HEAD`)
  })

  it('falls back to the Windows spelling when realpath fails', async () => {
    usePlatform('win32')
    mocks.realpath.mockRejectedValue(new Error('ELOOP'))
    mockLayout({ 'C:/repo/.git': null })

    await runWithGitFetchHeadLock(String.raw`C:\repo`, undefined, async () => 0)

    expect(lockKeys()[0]).toBe(String.raw`C:\repo\.git\FETCH_HEAD`)
  })

  it("keeps today's key for a guest pointer Windows cannot address", async () => {
    usePlatform('win32')
    mocks.stat.mockResolvedValue(GIT_FILE_ENTRY)
    mocks.readFile.mockImplementation(async (target: string) => {
      if (String(target).endsWith('commondir')) {
        throw new Error('no commondir')
      }
      return 'gitdir: /home/me/repo/.git/worktrees/wt\n'
    })

    await runWithGitFetchHeadLock(String.raw`C:\workspace\wt`, undefined, async () => 0)

    // Unchanged from main: no distro is known, so the pointer stays on the current drive rather
    // than becoming a new rootless `\home\...` lane.
    expect(lockKeys()[0]).toBe(String.raw`C:\home\me\repo\.git\worktrees\wt\FETCH_HEAD`)
  })

  it('never fabricates a Windows drive path on a POSIX host', async () => {
    usePlatform('darwin')
    mockLayout({ '/work/wt/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt\n' })

    await runWithGitFetchHeadLock('/work/wt', undefined, async () => 0)

    // `/mnt/c` is an ordinary directory here, not a drvfs mount, so it must not become `C:\repo`.
    expect(lockKeys()[0]).toBe('/mnt/c/repo/.git/worktrees/wt/FETCH_HEAD')
  })

  it('rejects promptly while a hung realpath is still pending', async () => {
    usePlatform('win32')
    let settleRealpath!: (value: string) => void
    mocks.realpath.mockReturnValue(
      new Promise<string>((resolve) => {
        settleRealpath = resolve
      })
    )
    const controller = new AbortController()

    const pending = runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\Ubuntu\home\me\repo`,
      controller.signal,
      async () => 0
    )
    // A caller-supplied reason must not change how callers classify the failure.
    controller.abort(new TypeError('cancelled by user'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    settleRealpath('never observed')
  })

  it('rejects promptly while a hung metadata stat is still pending', async () => {
    usePlatform('win32')
    let settleStat!: (value: typeof GIT_DIR_ENTRY) => void
    mocks.stat.mockReturnValue(
      new Promise((resolve) => {
        settleStat = resolve
      })
    )
    const controller = new AbortController()

    const pending = runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\Ubuntu\home\me\repo`,
      controller.signal,
      async () => 0
    )
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalled())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    settleStat(GIT_DIR_ENTRY)
  })
})
