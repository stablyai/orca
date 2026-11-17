import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

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
vi.mock('../commands/git-operation-lock', () => ({
  runWithGitOperationLock: mocks.runWithGitOperationLock
}))

import { runWithGitFetchHeadLock } from './git-fetch-head-lock'

const GIT_DIR_ENTRY = { isDirectory: () => true, isFile: () => false }
const GIT_FILE_ENTRY = { isDirectory: () => false, isFile: () => true }

function lockKeys(): string[] {
  return mocks.runWithGitOperationLock.mock.calls.map(([key]) => key as string)
}

/** Mock forward-slash metadata: strings are gitdir/commondir contents, null means .git directory.
 * Absent files throw so nonexistent paths cannot silently borrow sibling metadata. */
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

    // C:\mnt\c does not exist; strip drvfs prefixes or linked worktrees split from the main FETCH_HEAD lane.
    expect(lockKeys()).toEqual(Array(3).fill(String.raw`C:\repo\.git\FETCH_HEAD`))
  })

  it('keeps a WSL UNC repo and its linked worktree on one lane', async () => {
    usePlatform('win32')
    mockLayout({
      '//wsl.localhost/Ubuntu/mnt/c/repo/.git': null,
      '//wsl$/ubuntu/home/me/wt/.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt\n',
      '//wsl$/ubuntu/mnt/c/repo/.git/worktrees/wt/commondir': '../..\n'
    })

    // Main .git directories retain UNC keys; translating linked pointers alone to drive paths would split one repo.
    await runWithGitFetchHeadLock(
      String.raw`\\wsl.localhost\Ubuntu\mnt\c\repo`,
      undefined,
      async () => 0
    )
    await runWithGitFetchHeadLock(String.raw`\\wsl$\ubuntu\home\me\wt`, undefined, async () => 0)

    expect(lockKeys()).toEqual(Array(2).fill('//wsl.localhost/ubuntu/mnt/c/repo/.git/fetch_head'))
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
