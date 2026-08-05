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
  // --- Phase 8: the local commit protocol -------------------------------
  //
  // Every command below predates Git 2.25 by a wide margin, so the assertion is
  // that ALL supported versions behave identically with NO fallback path. That
  // is deliberately a non-event: recording it is what stops a future widening
  // from silently regressing the floor. No GitCapabilityCache entry is added,
  // because there is no capability to probe and nothing to fall back to.
  it('supports the Phase 8 commit protocol shapes', async () => {
    const tree = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const parent = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const messageFile = join(repoPath, 'commit-message.txt')
    await writeFile(messageFile, 'phase 8 compatibility\n')

    // commit-tree reads the message from a FILE, never argv: a commit message
    // can carry sensitive context and process listings are world-readable.
    const created = (
      await runGit(['commit-tree', tree, '-p', parent, '-F', messageFile])
    ).stdout.trim()
    expect(created).toMatch(/^[0-9a-f]{40}$/)

    // The object exists and is a commit - the two cat-file probes commit
    // evidence uses to distinguish "absent" from "present but wrong type".
    await expect(runGit(['cat-file', '-e', created])).resolves.toBeDefined()
    expect((await runGit(['cat-file', '-t', created])).stdout.trim()).toBe('commit')

    // cat-file commit is parsed for tree/parent/message by readCommitEvidence.
    const raw = (await runGit(['cat-file', 'commit', created])).stdout
    expect(raw).toContain(`tree ${tree}`)
    expect(raw).toContain(`parent ${parent}`)
    expect(raw).toContain('phase 8 compatibility')

    // rev-list --count is the ancestry probe. The COUNTING form must stay
    // distinct from the enumerating `--objects` form, which needs a candidate
    // store attached; only the counting form reaches the read path.
    expect((await runGit(['rev-list', '--count', `${parent}..${created}`])).stdout.trim()).toBe('1')
    expect((await runGit(['rev-list', '--count', `${created}..${parent}`])).stdout.trim()).toBe('0')

    // The shared repo must be left clean: later readiness probes assert an
    // EMPTY `status --porcelain`, so a stray untracked file would fail them.
    await rm(messageFile, { force: true })
  })

  it('supports the three-operand update-ref CAS and rejects a stale expectation', async () => {
    const branch = 'compat-cas'
    const base = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['branch', '-f', branch, base])

    const tree = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const messageFile = join(repoPath, 'cas-message.txt')
    await writeFile(messageFile, 'cas target\n')
    const target = (
      await runGit(['commit-tree', tree, '-p', base, '-F', messageFile])
    ).stdout.trim()

    // A matching expected-old advances the ref.
    await expect(
      runGit(['update-ref', `refs/heads/${branch}`, target, base])
    ).resolves.toBeDefined()
    expect((await runGit(['rev-parse', branch])).stdout.trim()).toBe(target)

    // A STALE expected-old is rejected LOUDLY and leaves the ref intact. This is
    // the only concurrency guarantee Git itself provides for the commit and
    // landing protocols, so a silent overwrite here would be catastrophic.
    await expect(runGit(['update-ref', `refs/heads/${branch}`, base, base])).rejects.toBeDefined()
    expect((await runGit(['rev-parse', branch])).stdout.trim()).toBe(target)

    await rm(messageFile, { force: true })
  })

  // --- Phase 10: the local landing protocol -----------------------------
  it('supports the Phase 10 readiness probes in their exact screened forms', async () => {
    // Both are admitted ONLY in one canonical shape, because the arity screens
    // depend on the exact output contract.
    expect((await runGit(['status', '--porcelain'])).stdout.trim()).toBe('')
    await expect(runGit(['diff-index', '--quiet', 'HEAD', '--'])).resolves.toBeDefined()

    // A dirty tree must make status non-empty AND diff-index exit non-zero, so
    // the two probes cannot disagree about readiness.
    await writeFile(join(repoPath, 'tracked.txt'), 'dirtied\n')
    expect((await runGit(['status', '--porcelain'])).stdout.trim()).not.toBe('')
    await expect(runGit(['diff-index', '--quiet', 'HEAD', '--'])).rejects.toBeDefined()

    await runGit(['checkout', '--', 'tracked.txt'])
    expect((await runGit(['status', '--porcelain'])).stdout.trim()).toBe('')
  })

  it('supports read-tree -m -u and refuses rather than clobbering a dirty file', async () => {
    const base = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['checkout', '-q', '-b', 'compat-land', base])
    await writeFile(join(repoPath, 'landed.txt'), 'landed content\n')
    await runGit(['add', 'landed.txt'])
    await runGit(['commit', '-qm', 'landing target'])
    const target = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()

    // Return to base with a clean tree, then apply the landing update.
    await runGit(['checkout', '-q', '--detach', base])
    await writeFile(join(repoPath, 'keep-me.local'), 'untracked payload\n')

    await expect(runGit(['read-tree', '-m', '-u', base, target])).resolves.toBeDefined()
    // The index AND the working tree moved.
    expect((await runGit(['ls-files', 'landed.txt'])).stdout.trim()).toBe('landed.txt')
    // The untracked file survived byte-intact - the guarantee that makes landing
    // safe to run against a user's own working tree.
    expect((await runGit(['status', '--porcelain'])).stdout).toContain('keep-me.local')

    // With a DIRTY file that DIFFERS between the two trees, -m refuses rather
    // than overwriting. landed.txt is the file the landing commit changes, so
    // dirtying THAT is what makes the safety check meaningful — a file identical
    // in both trees merges cleanly and would prove nothing.
    await runGit(['read-tree', '-m', '-u', target, base])
    await writeFile(join(repoPath, 'landed.txt'), 'local edit\n')
    await expect(runGit(['read-tree', '-m', '-u', base, target])).rejects.toBeDefined()

    // Restore the shared repo to base with a clean tree for later tests.
    await runGit(['read-tree', '--reset', '-u', base])
    await rm(join(repoPath, 'keep-me.local'), { force: true })
    await runGit(['checkout', '-q', base])
  })

  it('reports the holder path for a branch checked out in another worktree', async () => {
    // The evidence behind source_repo_branch_not_checked_out: landing into a
    // branch some OTHER worktree holds would desynchronize that worktree.
    const linked = join(repoPath, 'compat-linked-worktree')
    try {
      await runGit(['worktree', 'add', '-q', '-b', 'compat-held', linked])
      const listed = (await runGit(['worktree', 'list', '--porcelain'])).stdout
      expect(listed).toContain('branch refs/heads/compat-held')
      // The holder path is reported, which is what lets the check compare it
      // against the recorded source repo path.
      expect(listed).toContain('compat-linked-worktree')
    } finally {
      await runGit(['worktree', 'remove', '--force', linked]).catch(() => {})
      await rm(linked, { recursive: true, force: true })
    }
  })
})
