import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from './git-merge-tree-capability'
import { isForEachRefExcludeUnsupportedError } from './git-ref-command-capabilities'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedWorktreeListZError
} from './git-worktree-command-capabilities'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'
import { endSubprocessStdin } from './subprocess-stdin-write'
import { classifyGitDiscardPaths, gitDiscardStatusArgs } from './git-discard-status'
import {
  gitStagedDiscardArgs,
  gitStagedDiscardStatusArgs,
  resolveGitStagedDiscardPaths
} from './git-staged-discard-operation'
import {
  githubPullRequestHeadLocalRef,
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from './review-head-tracking-ref'

const execFileAsync = promisify(execFile)
const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const describeBinaryCompatibility = image || binary ? describe : describe.skip

type GitResult = { stdout: string; stderr: string }

describeBinaryCompatibility('real Git binary compatibility', () => {
  let repoPath = ''
  let version = { major: 0, minor: 0 }

  async function runGit(
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ): Promise<GitResult> {
    const execute = (
      command: string,
      commandArgs: string[],
      options: Parameters<typeof execFile>[2]
    ): Promise<GitResult> => {
      if (stdin === undefined) {
        return execFileAsync(command, commandArgs, options) as Promise<GitResult>
      }
      return new Promise((resolve, reject) => {
        const child = execFile(command, commandArgs, options, (error, stdout, stderr) => {
          if (error) {
            reject(error)
          } else {
            resolve({ stdout: String(stdout), stderr: String(stderr) })
          }
        })
        endSubprocessStdin(child.stdin, stdin)
      })
    }
    if (image) {
      const dockerUser =
        typeof process.getuid === 'function' && typeof process.getgid === 'function'
          ? ['--user', `${process.getuid()}:${process.getgid()}`]
          : []
      return execute(
        'docker',
        [
          'run',
          '--rm',
          '--network=none',
          ...dockerUser,
          ...Object.entries(env ?? {}).flatMap(([key, value]) =>
            value === undefined ? [] : ['--env', `${key}=${value}`]
          ),
          '-v',
          `${repoPath}:/repo`,
          '-w',
          '/repo',
          image,
          '-c',
          'safe.directory=/repo',
          ...args
        ],
        { maxBuffer: 2 * 1024 * 1024 }
      )
    }
    return execute(binary!, args, {
      cwd: repoPath,
      env: env ? { ...process.env, ...env } : undefined,
      maxBuffer: 2 * 1024 * 1024
    })
  }

  function supports(major: number, minor: number): boolean {
    return version.major > major || (version.major === major && version.minor >= minor)
  }

  async function expectPreferredOrRecognizedFallback(
    args: string[],
    expectedSupport: boolean,
    recognizesUnsupported: (error: unknown) => boolean
  ): Promise<void> {
    try {
      await runGit(args)
      expect(expectedSupport).toBe(true)
    } catch (error) {
      expect(expectedSupport).toBe(false)
      expect(recognizesUnsupported(error)).toBe(true)
    }
  }

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'orca-git-binary-compat-'))
    const versionOutput = await runGit(['--version'])
    expect(versionOutput.stdout).toContain(`git version ${expectedVersion}`)
    const match = versionOutput.stdout.match(/git version (\d+)\.(\d+)/)
    expect(match).not.toBeNull()
    version = { major: Number(match![1]), minor: Number(match![2]) }

    await runGit(['init', '-q'])
    await runGit(['config', 'user.email', 'compatibility@example.invalid'])
    await runGit(['config', 'user.name', 'Compatibility Test'])
    await writeFile(join(repoPath, 'tracked.txt'), 'compatibility\n')
    await runGit(['add', 'tracked.txt'])
    await runGit(['commit', '-qm', 'initial'])
  })

  afterAll(async () => {
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('recognizes worktree-list and rev-parse compatibility boundaries', async () => {
    await expectPreferredOrRecognizedFallback(
      ['worktree', 'list', '--porcelain', '-z'],
      supports(2, 36),
      isUnsupportedWorktreeListZError
    )
    await expect(runGit(['worktree', 'list', '--porcelain'])).resolves.toMatchObject({
      stdout: expect.stringContaining('worktree ')
    })

    // Why: the `prunable` porcelain annotation landed in Git 2.31 — five
    // releases before `-z` (2.36) — so only Git <2.31 emits neither and needs
    // Orca's path-existence fallback (issue #8389).
    await runGit(['worktree', 'add', '-b', 'compat-stale', 'stale-wt'])
    await rm(join(repoPath, 'stale-wt'), { recursive: true, force: true })
    const staleList = await runGit(['worktree', 'list', '--porcelain'])
    expect(staleList.stdout.includes('prunable')).toBe(supports(2, 31))

    const preferred = await runGit([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir'
    ])
    expect(hasUnsupportedRevParsePathFormatEcho(preferred.stdout)).toBe(!supports(2, 31))
    await expect(
      runGit(['rev-parse', '--show-toplevel', '--git-common-dir'])
    ).resolves.toBeDefined()
  })

  it('deregisters a worktree whose directory was renamed away', async () => {
    // Orca renames the checkout into a trash directory and then clears the registration, so every
    // supported Git must accept `worktree remove --force` on the now-missing path.
    await runGit(['worktree', 'add', '-b', 'compat-deferred', 'deferred-wt'])
    await rename(join(repoPath, 'deferred-wt'), join(repoPath, 'deferred-trash'))

    await expect(runGit(['worktree', 'remove', '--force', 'deferred-wt'])).resolves.toBeDefined()

    const remaining = await runGit(['worktree', 'list', '--porcelain'])
    expect(remaining.stdout).not.toContain('deferred-wt')
    await rm(join(repoPath, 'deferred-trash'), { recursive: true, force: true })
  })

  it('recognizes ref and merge-tree compatibility boundaries', async () => {
    await expectPreferredOrRecognizedFallback(
      ['for-each-ref', '--format=%(refname)', '--exclude=refs/remotes/**/HEAD', '--count=10'],
      supports(2, 42),
      isForEachRefExcludeUnsupportedError
    )
    await expect(
      runGit(['for-each-ref', '--format=%(refname)', '--count=10'])
    ).resolves.toBeDefined()

    await expectPreferredOrRecognizedFallback(
      ['merge-tree', '--write-tree', 'HEAD', 'HEAD'],
      supports(2, 38),
      isUnsupportedMergeTreeWriteTreeError
    )
    if (supports(2, 38)) {
      const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      const legacyArgs = ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages']
      await expectPreferredOrRecognizedFallback(
        [...legacyArgs, '--merge-base', head, head, head],
        supports(2, 40),
        isUnsupportedMergeTreeMergeBaseError
      )
      await expect(runGit([...legacyArgs, head, head])).resolves.toBeDefined()
    }
  })

  it('fetches hosted review heads into dedicated refs', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['update-ref', 'refs/pull/42/head', head])
    await runGit(['update-ref', 'refs/merge-requests/42/head', head])

    // Why: exercise the exact remote-identity-scoped ref shape the app generates.
    const component = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    const pullRef = githubPullRequestHeadLocalRef(component, 42)
    const mergeRequestRef = gitlabMergeRequestHeadLocalRef(component, 42)
    await expect(
      runGit(['fetch', '--no-tags', '.', `+refs/pull/42/head:${pullRef}`])
    ).resolves.toBeDefined()
    await expect(
      runGit(['fetch', '--no-tags', '.', `+refs/merge-requests/42/head:${mergeRequestRef}`])
    ).resolves.toBeDefined()
    await expect(runGit(['rev-parse', '--verify', pullRef])).resolves.toMatchObject({
      stdout: `${head}\n`
    })
    await expect(runGit(['rev-parse', '--verify', mergeRequestRef])).resolves.toMatchObject({
      stdout: `${head}\n`
    })
  })

  it('classifies discard state and restores staged content from the index', async () => {
    await writeFile(join(repoPath, 'discard-staged.txt'), 'staged\n')
    await runGit(['add', 'discard-staged.txt'])
    await writeFile(join(repoPath, 'discard-staged.txt'), 'staged\nunstaged\n')
    await writeFile(join(repoPath, 'discard-intent.txt'), 'intent\n')
    await runGit(['add', '-N', 'discard-intent.txt'])
    const selectedPaths = ['discard-staged.txt', 'discard-intent.txt']
    const { stdout } = await runGit(gitDiscardStatusArgs(selectedPaths, (filePath) => filePath))

    expect(Object.fromEntries(classifyGitDiscardPaths(stdout, selectedPaths))).toEqual({
      'discard-intent.txt': 'intent-to-add',
      'discard-staged.txt': 'tracked'
    })

    await runGit(['restore', '--worktree', '--', 'discard-staged.txt'])
    await runGit(['reset', '--', 'discard-intent.txt'])
    await runGit(['clean', '-ffdx', '--', 'discard-intent.txt'])

    await expect(readFile(join(repoPath, 'discard-staged.txt'), 'utf8')).resolves.toBe('staged\n')
    await expect(readFile(join(repoPath, 'discard-intent.txt'), 'utf8')).rejects.toThrow()
    await expect(
      runGit(['status', '--porcelain=v1', '--', ...selectedPaths])
    ).resolves.toMatchObject({
      stdout: 'A  discard-staged.txt\n'
    })
  })

  it('atomically restores staged index and worktree content from HEAD', async () => {
    await writeFile(join(repoPath, 'tracked.txt'), 'staged\n')
    await runGit(['add', 'tracked.txt'])
    await writeFile(join(repoPath, 'tracked.txt'), 'staged\nunstaged\n')

    await runGit(gitStagedDiscardArgs(['tracked.txt']))

    await expect(readFile(join(repoPath, 'tracked.txt'), 'utf8')).resolves.toBe('compatibility\n')
    await expect(runGit(['status', '--porcelain=v1', '--', 'tracked.txt'])).resolves.toMatchObject({
      stdout: ''
    })

    await runGit(['mv', 'tracked.txt', 'renamed.txt'])
    const { stdout } = await runGit(gitStagedDiscardStatusArgs())
    const selection = resolveGitStagedDiscardPaths(stdout, ['renamed.txt'])
    expect(selection).toEqual({ paths: ['renamed.txt', 'tracked.txt'], hasConflict: false })
    await runGit(gitStagedDiscardArgs(selection.paths))
    await expect(readFile(join(repoPath, 'tracked.txt'), 'utf8')).resolves.toBe('compatibility\n')
    await expect(readFile(join(repoPath, 'renamed.txt'), 'utf8')).rejects.toThrow()
  })

  it('restores staged additions from an empty tree on an unborn branch', async () => {
    await runGit(['init', '-q', 'unborn'])
    await writeFile(join(repoPath, 'unborn', 'selected.txt'), 'selected\n')
    await writeFile(join(repoPath, 'unborn', 'unrelated.txt'), 'unrelated\n')
    await runGit(['-C', 'unborn', 'add', 'selected.txt', 'unrelated.txt'])
    const emptyTree = (await runGit(['-C', 'unborn', 'mktree'], undefined, '')).stdout.trim()

    await runGit(['-C', 'unborn', ...gitStagedDiscardArgs(['selected.txt'], emptyTree)])

    await expect(readFile(join(repoPath, 'unborn', 'selected.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(repoPath, 'unborn', 'unrelated.txt'), 'utf8')).resolves.toBe(
      'unrelated\n'
    )
    await expect(runGit(['-C', 'unborn', 'status', '--porcelain=v1'])).resolves.toMatchObject({
      stdout: 'A  unrelated.txt\n'
    })
  })

  it('degrades indexed credential config safely at the Git 2.31 boundary', async () => {
    const guardEnv = gitCredentialPromptGuardEnv({}, 'linux')
    await expect(runGit(['status', '--short'], guardEnv)).resolves.toBeDefined()

    try {
      const result = await runGit(['config', '--get', 'credential.interactive'], guardEnv)
      expect(supports(2, 31)).toBe(true)
      expect(result.stdout.trim()).toBe('false')
    } catch {
      // Git 2.25 ignores the indexed variables rather than rejecting commands;
      // the scalar prompt guards still provide the baseline fail-fast behavior.
      expect(supports(2, 31)).toBe(false)
    }
  })

  // Why pin this: --verify swallows --end-of-options but --symbolic-full-name echoes
  // it deliberately, on every version tested (2.25 through 2.49). git-history.ts skips
  // that line; if a future git stopped emitting it, the skip stays correct, but if this
  // assertion ever flips the reason for the skip is worth re-reading.
  it('echoes the option marker from rev-parse --symbolic-full-name', async () => {
    const result = await runGit(['rev-parse', '--symbolic-full-name', '--end-of-options', 'HEAD'])
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)

    expect(lines[0]).toBe('--end-of-options')
    expect(lines.find((line) => line !== '--end-of-options')).toMatch(/^refs\//)
  })
})
