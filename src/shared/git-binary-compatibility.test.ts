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
import { isNoWriteFetchHeadUnsupportedError } from './git-fetch-head-capability'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedWorktreeListZError
} from './git-worktree-command-capabilities'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'
import { parseGitRemoteFetchUrls } from './git-remote-url-index'
import { GIT_HISTORY_COMMIT_FORMAT, parseGitHistoryLog } from './git-history-log-parser'
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

  it('supports prepared worktree creation and finalization', async () => {
    await runGit(['worktree', 'add', '--detach', '--no-checkout', 'compat-prepared', 'HEAD'])
    await runGit(['-C', 'compat-prepared', 'reset', '--hard', 'HEAD'])
    await runGit([
      'worktree',
      'lock',
      '--reason',
      'orca-create-preparation:v1:compat',
      'compat-prepared'
    ])
    // Why: `-f -f` moves a locked preparation while preserving its lock reason (Git >=2.25).
    await runGit(['worktree', 'move', '-f', '-f', 'compat-prepared', 'compat-final'])
    await runGit([
      '-C',
      'compat-final',
      'checkout',
      '--no-track',
      '-b',
      'compat-prepared-final',
      'HEAD'
    ])

    await expect(runGit(['-C', 'compat-final', 'branch', '--show-current'])).resolves.toMatchObject(
      { stdout: 'compat-prepared-final\n' }
    )
    await runGit(['worktree', 'unlock', 'compat-final'])
    await runGit(['worktree', 'remove', '--force', 'compat-final'])
    await runGit(['branch', '-D', 'compat-prepared-final'])
  })

  // Why pin this: the prepared-checkout retarget bound reads these as data, and it fails closed,
  // so a version that printed a different shape would silently stop every retarget rather than
  // error. Built with `commit-tree` so the check leaves no ref, branch, or worktree behind.
  it('measures retarget drift identically on every supported Git', async () => {
    const tree = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const ahead1 = (await runGit(['commit-tree', tree, '-p', head, '-m', 'drift 1'])).stdout.trim()
    const ahead2 = (
      await runGit(['commit-tree', tree, '-p', ahead1, '-m', 'drift 2'])
    ).stdout.trim()

    await expect(
      runGit(['rev-list', '--count', '--max-count=101', '--end-of-options', `${head}..${ahead2}`])
    ).resolves.toMatchObject({ stdout: '2\n' })
    // `--max-count` must report the capped number, not the full one: the bound reads it as a
    // ceiling, so a Git that returned the true count would reject every retarget instead.
    await expect(
      runGit(['rev-list', '--count', '--max-count=1', '--end-of-options', `${head}..${ahead2}`])
    ).resolves.toMatchObject({ stdout: '1\n' })
    await expect(
      runGit(['rev-list', '--count', '--max-count=101', '--end-of-options', `${ahead2}..${head}`])
    ).resolves.toMatchObject({ stdout: '0\n' })

    await expect(runGit(['merge-base', '--end-of-options', head, ahead2])).resolves.toMatchObject({
      stdout: `${head}\n`
    })
    // A parentless commit shares no history, which is the case the bound must reject however few
    // commits each side carries.
    const unrelated = (await runGit(['commit-tree', tree, '-m', 'unrelated root'])).stdout.trim()
    await expect(runGit(['merge-base', '--end-of-options', head, unrelated])).rejects.toBeDefined()
  })

  // Why pin this: Orca answers "which remote has this URL" from one `git remote -v`
  // instead of one `git remote get-url` per remote. That is only equivalent if both
  // commands report the same URL — the insteadOf-expanded first `remote.<name>.url`,
  // which a raw config read does not produce — on every supported Git.
  it('reports the same fetch URL from remote -v as from remote get-url', async () => {
    await runGit(['config', 'url.git@example.invalid:.insteadOf', 'https://example.invalid/'])
    await runGit(['remote', 'add', 'compat-single', 'https://example.invalid/a/repo.git'])
    await runGit(['remote', 'add', 'compat-multi', 'https://example.invalid/b/repo.git'])
    await runGit([
      'config',
      '--add',
      'remote.compat-multi.url',
      'https://example.invalid/b2/repo.git'
    ])
    await runGit([
      'config',
      'remote.compat-multi.pushurl',
      'https://push.example.invalid/b/repo.git'
    ])
    try {
      const fetchUrls = parseGitRemoteFetchUrls((await runGit(['remote', '-v'])).stdout)
      for (const name of ['compat-single', 'compat-multi']) {
        const getUrl = (await runGit(['remote', 'get-url', name])).stdout.trim()
        expect(fetchUrls.get(name)).toBe(getUrl)
      }
      expect(fetchUrls.get('compat-single')).toBe('git@example.invalid:a/repo.git')
      // A `pushurl` must not displace the fetch URL the scan compares against.
      expect(fetchUrls.get('compat-multi')).toBe('git@example.invalid:b/repo.git')
    } finally {
      await runGit(['remote', 'remove', 'compat-single'])
      await runGit(['remote', 'remove', 'compat-multi'])
      await runGit(['config', '--unset-all', 'url.git@example.invalid:.insteadOf'])
    }
  })

  it('recognizes ref and merge-tree compatibility boundaries', async () => {
    const fetchHeadPath = join(repoPath, '.git', 'FETCH_HEAD')
    await writeFile(fetchHeadPath, 'sentinel\n')
    await expectPreferredOrRecognizedFallback(
      ['fetch', '--no-write-fetch-head', '.', '+HEAD:refs/orca/compat/no-write-fetch-head'],
      supports(2, 29),
      isNoWriteFetchHeadUnsupportedError
    )
    await expect(readFile(fetchHeadPath, 'utf-8')).resolves.toBe('sentinel\n')
    // Why: ref search ships the excludes built by `getRemoteHeadExcludes`
    // (src/main/git/repo-base-ref-search.ts) — a single-component wildcard plus
    // an exact exclude per slash-containing remote name. The correctness of
    // that split rests on `*` not crossing `/` under wildmatch, which only a
    // real binary can prove.
    const commitOid = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    for (const ref of [
      'refs/remotes/origin/main',
      'refs/remotes/origin/compat-nested/HEAD',
      'refs/remotes/foo/bar/main',
      'refs/remotes/foo/bar/compat-nested/HEAD'
    ]) {
      await runGit(['update-ref', ref, commitOid])
    }
    await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    await runGit(['symbolic-ref', 'refs/remotes/foo/bar/HEAD', 'refs/remotes/foo/bar/main'])
    const exactRemoteHeadExclude = '--exclude=refs/remotes/foo/bar/HEAD'
    const shippedExcludeArgv = [
      'for-each-ref',
      '--format=%(refname)',
      '--exclude=refs/remotes/*/HEAD',
      exactRemoteHeadExclude,
      '--count=100',
      'refs/remotes/**'
    ]
    const wildcardExcludeArgv = shippedExcludeArgv.filter((arg) => arg !== exactRemoteHeadExclude)
    await expectPreferredOrRecognizedFallback(
      shippedExcludeArgv,
      supports(2, 42),
      isForEachRefExcludeUnsupportedError
    )
    if (supports(2, 42)) {
      const listRefs = async (argv: string[]): Promise<string[]> =>
        (await runGit(argv)).stdout.split(/\r?\n/).filter(Boolean)

      expect(await listRefs(shippedExcludeArgv)).toEqual([
        'refs/remotes/foo/bar/compat-nested/HEAD',
        'refs/remotes/foo/bar/main',
        'refs/remotes/origin/compat-nested/HEAD',
        'refs/remotes/origin/main'
      ])
      // The wildcard cannot reach a slash-containing remote's HEAD slot, which
      // is the whole reason the exact excludes are emitted alongside it.
      expect(await listRefs(wildcardExcludeArgv)).toContain('refs/remotes/foo/bar/HEAD')
    }
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

  it('supports exact show-ref probes', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const originRef = 'refs/remotes/origin/compat-exact'
    const missingRef = 'refs/remotes/missing/compat-exact'
    await runGit(['update-ref', originRef, head])

    await expect(
      runGit(['show-ref', '--verify', '--quiet', '--', originRef])
    ).resolves.toBeDefined()
    await expect(
      runGit(['show-ref', '--verify', '--quiet', '--', missingRef])
    ).rejects.toMatchObject({ code: 1 })

    const nestedRef = 'refs/remotes/origin/compat-parent/nested'
    await runGit(['update-ref', nestedRef, head])
    await expect(
      runGit(['show-ref', '--verify', '--quiet', '--', 'refs/remotes/origin/compat-parent'])
    ).rejects.toMatchObject({ code: 1 })
  })

  it('packs loose refs and reads the maintenance opt-out at the baseline', async () => {
    // Why: idle ref maintenance runs `pack-refs --all --prune` on every supported
    // Git rather than the 2.45+ `--auto` form, and reads `maintenance.auto` to
    // honour a user who disabled Git's own auto-maintenance. Both must work at 2.25.
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const packedRef = 'refs/remotes/origin/compat-pack-refs'
    await runGit(['update-ref', packedRef, head])
    await expect(readFile(join(repoPath, '.git', packedRef), 'utf-8')).resolves.toContain(head)

    await expect(runGit(['pack-refs', '--all', '--prune'])).resolves.toBeDefined()

    // The loose file is gone and the ref still resolves through packed-refs.
    await expect(readFile(join(repoPath, '.git', packedRef), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(runGit(['rev-parse', '--verify', packedRef])).resolves.toMatchObject({
      stdout: `${head}\n`
    })
    await expect(readFile(join(repoPath, '.git', 'packed-refs'), 'utf-8')).resolves.toContain(
      packedRef
    )

    // `--get` exits 1 on an unset key; that absence must read as consent, not opt-out.
    await expect(runGit(['config', '--bool', '--get', 'maintenance.auto'])).rejects.toMatchObject({
      code: 1
    })
    await runGit(['config', 'maintenance.auto', 'false'])
    await expect(runGit(['config', '--bool', '--get', 'maintenance.auto'])).resolves.toMatchObject({
      stdout: 'false\n'
    })
    await runGit(['config', '--unset', 'maintenance.auto'])
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

  it('supports isolated worktree backup refs', async () => {
    const worktree = 'compat-lint-staged'
    const backupRef = 'refs/worktree/lint-staged-backups/compat'
    await runGit(['worktree', 'add', '-b', 'compat-lint-staged', worktree])
    await writeFile(join(repoPath, worktree, 'tracked.txt'), 'staged\n')
    await runGit(['-C', worktree, 'add', 'tracked.txt'])
    await writeFile(join(repoPath, worktree, 'tracked.txt'), 'staged\nunstaged\n')

    const backupOid = (await runGit(['-C', worktree, 'stash', 'create'])).stdout.trim()
    await runGit([
      '-C',
      worktree,
      'update-ref',
      backupRef,
      backupOid,
      '0000000000000000000000000000000000000000'
    ])
    await expect(
      runGit(['-C', worktree, 'rev-parse', '--verify', backupRef])
    ).resolves.toMatchObject({ stdout: `${backupOid}\n` })
    await expect(runGit(['rev-parse', '--verify', backupRef])).rejects.toBeDefined()

    await runGit(['-C', worktree, 'reset', '--hard', 'HEAD'])
    await expect(
      runGit(['-C', worktree, 'stash', 'apply', '--quiet', '--index', backupRef])
    ).resolves.toBeDefined()
    await expect(runGit(['-C', worktree, 'status', '--short'])).resolves.toMatchObject({
      stdout: 'MM tracked.txt\n'
    })
    await runGit(['-C', worktree, 'update-ref', '-d', backupRef, backupOid])
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

  // Why pin this: `show --end-of-options <oid>:<path>` is the only Git command on the
  // pinned SSH branch-diff path, and both blob sides depend on it resolving against the
  // named commit rather than live HEAD, and on failing (not falling back) for a path
  // absent at that commit — that failure is what renders additions and deletions.
  it('reads a blob at a pinned object id', async () => {
    await writeFile(join(repoPath, 'pinned.txt'), 'pinned\n')
    await runGit(['add', 'pinned.txt'])
    await runGit(['commit', '-qm', 'pinned'])
    const pinnedOid = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()

    await writeFile(join(repoPath, 'pinned.txt'), 'moved on\n')
    await runGit(['commit', '-qam', 'after pinned'])

    await expect(
      runGit(['show', '--end-of-options', `${pinnedOid}:pinned.txt`])
    ).resolves.toMatchObject({ stdout: 'pinned\n' })
    await expect(
      runGit(['show', '--end-of-options', `${pinnedOid}:absent.txt`])
    ).rejects.toBeDefined()
  })
  // Why pin this: an older Git echoes %(decorate:…) and exits zero, so only %D
  // in the same record carries the badges (#15507). Asserts the echo and the recovery.
  it('reads commit decorations on both sides of the %(decorate:...) boundary', async () => {
    await writeFile(join(repoPath, 'decorated.txt'), 'decorated\n')
    await runGit(['add', 'decorated.txt'])
    await runGit(['commit', '-qm', 'decorated commit'])
    await runGit(['tag', 'compat-decorated'])
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()

    const log = await runGit([
      'log',
      `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
      '-z',
      '--decorate=full',
      '-n1',
      head
    ])

    expect(log.stdout.includes('%(decorate')).toBe(!supports(2, 43))

    const [item] = parseGitHistoryLog(log.stdout)
    expect(item?.id).toBe(head)
    expect(item?.subject).toBe('decorated commit')
    expect(item?.references?.map((ref) => ref.id)).toContain('refs/tags/compat-decorated')
  })
})
