import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  async function runGit(args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
    if (image) {
      const dockerUser =
        typeof process.getuid === 'function' && typeof process.getgid === 'function'
          ? ['--user', `${process.getuid()}:${process.getgid()}`]
          : []
      return execFileAsync(
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
    return execFileAsync(binary!, args, {
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
  // Phase 9 publish lane. Every command here long predates 2.25, so there is no
  // capability probe and no fallback — but the SEMANTICS the design depends on
  // must be identical across the matrix, because a difference would silently
  // change how an outcome is classified.
  it('supports the explicit force-with-lease push and rejects a stale lease', async () => {
    const remotePath = await mkdtemp(join(tmpdir(), 'orca-git-compat-remote-'))
    try {
      await runGit(['init', '-q', '--bare', remotePath])
      await runGit(['remote', 'add', 'lease-origin', remotePath])
      const branch = 'compat-lease'
      await runGit(['branch', '-f', branch, 'HEAD'])
      const first = (await runGit(['rev-parse', branch])).stdout.trim()

      // Create-only: the EMPTY lease publishes a branch that does not exist yet.
      await expect(
        runGit([
          'push',
          `--force-with-lease=refs/heads/${branch}:`,
          '--',
          'lease-origin',
          `${first}:refs/heads/${branch}`
        ])
      ).resolves.toBeDefined()

      // ls-remote reports a PRESENT ref on stdout with exit 0.
      const present = await runGit(['ls-remote', '--', 'lease-origin', `refs/heads/${branch}`])
      expect(present.stdout).toContain(first)

      // ls-remote reports a MISSING ref as exit 0 with EMPTY stdout. This is the
      // classification-critical behavior: absence must never look like a
      // transport failure.
      const missing = await runGit(['ls-remote', '--', 'lease-origin', 'refs/heads/compat-absent'])
      expect(missing.stdout.trim()).toBe('')

      // A matching explicit lease pushes.
      await writeFile(join(repoPath, 'lease.txt'), 'second\n')
      await runGit(['add', 'lease.txt'])
      await runGit(['commit', '-q', '-m', 'lease second'])
      const second = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      await expect(
        runGit([
          'push',
          `--force-with-lease=refs/heads/${branch}:${first}`,
          '--',
          'lease-origin',
          `${second}:refs/heads/${branch}`
        ])
      ).resolves.toBeDefined()

      // A STALE lease is rejected loudly, leaving the remote untouched.
      await writeFile(join(repoPath, 'lease.txt'), 'third\n')
      await runGit(['add', 'lease.txt'])
      await runGit(['commit', '-q', '-m', 'lease third'])
      const third = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      await expect(
        runGit([
          'push',
          `--force-with-lease=refs/heads/${branch}:${first}`,
          '--',
          'lease-origin',
          `${third}:refs/heads/${branch}`
        ])
      ).rejects.toBeDefined()

      const afterRejection = await runGit([
        'ls-remote',
        '--',
        'lease-origin',
        `refs/heads/${branch}`
      ])
      expect(afterRejection.stdout).toContain(second)
      expect(afterRejection.stdout).not.toContain(third)

      // The empty lease also refuses when the ref exists at a different value.
      await expect(
        runGit([
          'push',
          `--force-with-lease=refs/heads/${branch}:`,
          '--',
          'lease-origin',
          `${third}:refs/heads/${branch}`
        ])
      ).rejects.toBeDefined()
    } finally {
      await rm(remotePath, { recursive: true, force: true })
    }
  })
})
