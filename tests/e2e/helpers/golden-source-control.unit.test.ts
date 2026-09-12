import { execFileSync } from 'node:child_process'
import type * as NodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGoldenWorktree,
  GOLDEN_GIT_AUTHOR_EMAIL,
  GOLDEN_GIT_AUTHOR_NAME,
  goldenWorktreePathsMatch
} from './golden-source-control'

const { realpathSyncNativeMock } = vi.hoisted(() => ({
  realpathSyncNativeMock: vi.fn((value: string) => value)
}))

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    realpathSync: Object.assign(
      (target: NodeFs.PathLike, options?: NodeFs.EncodingOption) =>
        actual.realpathSync(target, options),
      { native: realpathSyncNativeMock }
    )
  }
})

const execFileSyncMock = vi.mocked(execFileSync)

const WINDOWS_SHORT_WORKTREE = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\e2e-golden-file-save-1'
const WINDOWS_LONG_WORKTREE = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\e2e-golden-file-save-1'

type GitCall = { args: string[]; cwd?: string }

/** Setup runs in the new worktree while rollback runs in the repo, so cwd is part of the contract. */
const gitCallsFor = (): GitCall[] =>
  execFileSyncMock.mock.calls.map(([, args, options]) => ({
    args: (args ?? []) as string[],
    cwd: (options as { cwd?: string } | undefined)?.cwd
  }))

/** Args-only view for lookups that locate a call rather than assert its full shape. */
const gitArgsFor = (): string[][] => gitCallsFor().map((call) => call.args)

/** Returns the thrown value itself; `toThrow` only compares messages, not identity. */
const captureThrow = (run: () => void): unknown => {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

/** The worktree path and branch name are randomly suffixed, so read them back off the add call. */
const worktreeAddTargets = (): { branchName: string; worktreePath: string } => {
  const addArgs = gitArgsFor().find((args) => args[0] === 'worktree' && args[1] === 'add')
  expect(addArgs).toBeDefined()
  const [, , worktreePath, , branchName] = addArgs as string[]
  return { branchName, worktreePath }
}

describe('goldenWorktreePathsMatch', () => {
  beforeEach(() => {
    realpathSyncNativeMock.mockReset()
    realpathSyncNativeMock.mockImplementation((value: string) => value)
  })

  it('matches a Windows 8.3 tmpdir alias to the long path Git lists', () => {
    realpathSyncNativeMock.mockImplementation((value: string) =>
      String(value).includes('RUNNER~1') ? WINDOWS_LONG_WORKTREE : String(value)
    )

    expect(goldenWorktreePathsMatch(WINDOWS_SHORT_WORKTREE, WINDOWS_LONG_WORKTREE, 'win32')).toBe(
      true
    )
    expect(realpathSyncNativeMock).toHaveBeenCalledWith(WINDOWS_SHORT_WORKTREE)
    expect(realpathSyncNativeMock).toHaveBeenCalledWith(WINDOWS_LONG_WORKTREE)
  })

  it('still folds slashes and case on Windows when realpath is a no-op', () => {
    expect(
      goldenWorktreePathsMatch(
        'C:\\Users\\RUNNERADMIN\\AppData\\Local\\Temp\\wt',
        'C:/Users/runneradmin/AppData/Local/Temp/wt',
        'win32'
      )
    ).toBe(true)
  })

  it('does not match distinct worktrees after canonicalization', () => {
    expect(
      goldenWorktreePathsMatch(
        'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\e2e-golden-a',
        'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\e2e-golden-b',
        'win32'
      )
    ).toBe(false)
  })
})

describe('createGoldenWorktree', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
    realpathSyncNativeMock.mockReset()
    realpathSyncNativeMock.mockImplementation((value: string) => value)
  })

  /** A half-built worktree leaks into later runs unless both the worktree and the branch go away. */
  it('rolls back the worktree and branch when a configuration command fails', () => {
    const setupError = new Error('git config --worktree unsupported')
    execFileSyncMock.mockImplementation(((_file: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === 'extensions.worktreeConfig') {
        throw setupError
      }
      return ''
    }) as unknown as typeof execFileSync)

    expect(captureThrow(() => createGoldenWorktree('/repo', 'rollback'))).toBe(setupError)

    const { branchName, worktreePath } = worktreeAddTargets()
    expect(branchName).toMatch(/^e2e-golden-rollback-/)
    expect(gitCallsFor()).toContainEqual({
      args: ['worktree', 'remove', '--force', worktreePath],
      cwd: '/repo'
    })
    expect(gitCallsFor()).toContainEqual({ args: ['branch', '-D', branchName], cwd: '/repo' })
  })

  /** Rollback must still be attempted in full, and its own failure must not mask the setup cause. */
  it('keeps the setup error when rollback itself fails', () => {
    const setupError = new Error('git config --worktree unsupported')
    execFileSyncMock.mockImplementation(((_file: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === 'extensions.worktreeConfig') {
        throw setupError
      }
      if (args[0] === 'branch') {
        throw new Error('branch is still checked out')
      }
      return ''
    }) as unknown as typeof execFileSync)

    expect(captureThrow(() => createGoldenWorktree('/repo', 'rollback-fails'))).toBe(setupError)

    const { branchName, worktreePath } = worktreeAddTargets()
    expect(branchName).toMatch(/^e2e-golden-rollback-fails-/)
    expect(gitCallsFor()).toContainEqual({
      args: ['worktree', 'remove', '--force', worktreePath],
      cwd: '/repo'
    })
    expect(gitCallsFor()).toContainEqual({ args: ['branch', '-D', branchName], cwd: '/repo' })
  })

  /** The identity config must land on the worktree, not the repo, or commits pick up the host author. */
  it('returns the fixture when every setup command succeeds', () => {
    execFileSyncMock.mockReturnValue('')

    const fixture = createGoldenWorktree('/repo', 'happy')

    expect(fixture.branchName).toMatch(/^e2e-golden-happy-/)
    expect(fixture.worktreePath).toBe(path.join(os.tmpdir(), fixture.branchName))
    // Exhaustive: also proves no rollback ran.
    expect(gitCallsFor()).toEqual([
      { args: ['worktree', 'add', fixture.worktreePath, '-b', fixture.branchName], cwd: '/repo' },
      { args: ['config', 'extensions.worktreeConfig', 'true'], cwd: fixture.worktreePath },
      {
        args: ['config', '--worktree', 'user.name', GOLDEN_GIT_AUTHOR_NAME],
        cwd: fixture.worktreePath
      },
      {
        args: ['config', '--worktree', 'user.email', GOLDEN_GIT_AUTHOR_EMAIL],
        cwd: fixture.worktreePath
      }
    ])
  })

  it('stores the native realpath after add so later Git cwd and activate match', () => {
    execFileSyncMock.mockReturnValue('')
    realpathSyncNativeMock.mockReturnValue(WINDOWS_LONG_WORKTREE)

    const fixture = createGoldenWorktree('/repo', 'happy')
    const requestedPath = path.join(os.tmpdir(), fixture.branchName)

    expect(fixture.worktreePath).toBe(WINDOWS_LONG_WORKTREE)
    expect(realpathSyncNativeMock).toHaveBeenCalledWith(requestedPath)
    expect(gitCallsFor()).toEqual([
      { args: ['worktree', 'add', requestedPath, '-b', fixture.branchName], cwd: '/repo' },
      { args: ['config', 'extensions.worktreeConfig', 'true'], cwd: WINDOWS_LONG_WORKTREE },
      {
        args: ['config', '--worktree', 'user.name', GOLDEN_GIT_AUTHOR_NAME],
        cwd: WINDOWS_LONG_WORKTREE
      },
      {
        args: ['config', '--worktree', 'user.email', GOLDEN_GIT_AUTHOR_EMAIL],
        cwd: WINDOWS_LONG_WORKTREE
      }
    ])
  })
})
