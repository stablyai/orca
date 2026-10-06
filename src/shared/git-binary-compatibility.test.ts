import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from './git-merge-tree-capability'
import { isBranchCheckedOutInWorktreeError } from './git-branch-delete-refusal'
import { isForEachRefExcludeUnsupportedError } from './git-ref-command-capabilities'
import { isNoWriteFetchHeadUnsupportedError } from './git-fetch-head-capability'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedWorktreeAddLockReasonError,
  isUnsupportedWorktreeListZError
} from './git-worktree-command-capabilities'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'
import { buildGitGrepArgs } from './text-search'
import { parseGitRemoteFetchUrls } from './git-remote-url-index'
import { GIT_HISTORY_COMMIT_FORMAT, parseGitHistoryLog } from './git-history-log-parser'
import {
  githubPullRequestHeadLocalRef,
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from './review-head-tracking-ref'
import { parseWorktreeList } from './git-worktree-porcelain-parser'
import { fastForwardLocalBaseBranch } from './worktree/local-base-branch-fast-forward'
import { gitChangeListArgs, parseGitChangeList } from './git-change-list'
import { encodeGitPathspecs } from './git-pathspec-stdin'
import { endSubprocessStdin } from './subprocess-stdin-write'
import { registerGitResolutionBinaryCompatibilityCases } from './git-resolution-binary-compatibility.test-cases'

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
    if (image) {
      const dockerUser =
        typeof process.getuid === 'function' && typeof process.getgid === 'function'
          ? ['--user', `${process.getuid()}:${process.getgid()}`]
          : []
      const pending = execFileAsync(
        'docker',
        [
          'run',
          '--rm',
          ...(stdin === undefined ? [] : ['-i']),
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
      if (stdin !== undefined) {
        endSubprocessStdin(pending.child.stdin, stdin)
      }
      return pending
    }
    const pending = execFileAsync(binary!, args, {
      cwd: repoPath,
      env: {
        ...process.env,
        HOME: repoPath,
        XDG_CONFIG_HOME: repoPath,
        GIT_CONFIG_NOSYSTEM: '1',
        ...env
      },
      maxBuffer: 2 * 1024 * 1024
    })
    if (stdin !== undefined) {
      endSubprocessStdin(pending.child.stdin, stdin)
    }
    return pending
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

  it('stages, unstages and restores NUL-delimited literal pathspecs from stdin', async () => {
    const fixturePath = join(repoPath, 'stdin-pathspec')
    await mkdir(fixturePath)
    const fixtureCwd = image ? '/repo/stdin-pathspec' : fixturePath
    const runFixtureGit = (args: string[], stdin?: string): Promise<GitResult> =>
      runGit(['-C', fixtureCwd, ...args], undefined, stdin)
    await runFixtureGit(['init', '-q'])
    await runFixtureGit(['config', 'user.name', 'Compatibility Test'])
    await runFixtureGit(['config', 'user.email', 'compatibility@example.invalid'])
    const paths = ['[k]eep.log', 'space name.txt', '-option.txt']
    if (process.platform !== 'win32') {
      paths.push('line\nname.txt', ':(magic).txt')
    }
    await Promise.all(paths.map((filePath) => writeFile(join(fixturePath, filePath), 'original\n')))
    const stdin = encodeGitPathspecs(paths.map((filePath) => `:(literal)${filePath}`))
    await runFixtureGit(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], stdin)
    await runFixtureGit(['reset', '--quiet', '--', `:(literal)${paths[0]}`])
    expect(
      (await runFixtureGit(['ls-files', '-z'])).stdout.split('\0').filter(Boolean).sort()
    ).toEqual(paths.slice(1).sort())
    await runFixtureGit(
      ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin
    )
    expect((await runFixtureGit(['ls-files', '-z'])).stdout).toBe('')
    await runFixtureGit(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], stdin)
    await runFixtureGit(['commit', '-qm', 'stdin pathspec fixtures'])
    await Promise.all(paths.map((filePath) => writeFile(join(fixturePath, filePath), 'modified\n')))
    await runFixtureGit(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], stdin)
    const staged = await runFixtureGit(['diff', '--cached', '--name-only', '-z'])
    expect(staged.stdout.split('\0').filter(Boolean).sort()).toEqual([...paths].sort())
    await Promise.all(paths.map((filePath) => writeFile(join(fixturePath, filePath), 'working\n')))
    await runFixtureGit(
      ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin
    )
    for (const filePath of paths) {
      expect(await readFile(join(fixturePath, filePath), 'utf8')).toBe('modified\n')
    }
    await runFixtureGit(
      ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin
    )
    expect((await runFixtureGit(['diff', '--cached', '--name-only'])).stdout).toBe('')
    await runFixtureGit(
      ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin
    )
    for (const filePath of paths) {
      expect(await readFile(join(fixturePath, filePath), 'utf8')).toBe('original\n')
    }
    await rm(fixturePath, { recursive: true, force: true })
  })

  it('emits raw changes and numstat from one range or root diff', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const range = await runGit(gitChangeListArgs(head, head))
    expect(parseGitChangeList(range.stdout)).toEqual([])
    const root = await runGit(gitChangeListArgs(null, head))
    expect(parseGitChangeList(root.stdout)).toEqual([
      { path: 'tracked.txt', status: 'added', added: 1, removed: 0 }
    ])
    const names = await runGit([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-status',
      '-z',
      head,
      '--'
    ])
    expect(parseGitChangeList(names.stdout, 'name-status')).toEqual([
      { path: 'tracked.txt', status: 'added' }
    ])
  })

  it('reads signed history without launching configured signature verification', async () => {
    const tree = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const commit = [
      `tree ${tree}`,
      'author Compatibility Test <compatibility@example.invalid> 1234567890 +0000',
      'committer Compatibility Test <compatibility@example.invalid> 1234567890 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' ZHVtbXk=',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed history fixture',
      ''
    ].join('\n')
    const oid = (
      await runGit(['hash-object', '-t', 'commit', '-w', '--stdin'], undefined, commit)
    ).stdout.trim()
    const result = await runGit([
      '-c',
      'log.showSignature=true',
      '-c',
      'color.ui=always',
      '-c',
      'gpg.program=orca-nonexistent-signature-verifier',
      'log',
      '--no-show-signature',
      '--no-color',
      `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
      '-z',
      '-n1',
      oid
    ])
    expect(result.stderr).toBe('')
    expect(parseGitHistoryLog(result.stdout)).toMatchObject([
      { id: oid, subject: 'signed history fixture' }
    ])
  })

  it('keeps polling diffs from refreshing the index', async () => {
    const indexPath = join(repoPath, '.git', 'index')
    const before = await readFile(indexPath)
    const future = new Date(Date.now() + 10_000)
    await utimes(join(repoPath, 'tracked.txt'), future, future)
    const result = await runGit(
      ['-c', 'diff.autoRefreshIndex=false', 'diff', '--numstat', '-z', '--'],
      { GIT_OPTIONAL_LOCKS: '0' }
    )
    expect(['', '0\t0\ttracked.txt\0']).toContain(result.stdout)
    expect(await readFile(indexPath)).toEqual(before)
    await runGit(['-c', 'diff.autoRefreshIndex=true', 'diff', '--numstat', '-z', '--'])
    expect(await readFile(indexPath)).not.toEqual(before)
  })

  it('quietly distinguishes present and absent branch refs', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['branch', 'quiet-probe-present', head])
    await expect(
      runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/quiet-probe-present'])
    ).resolves.toMatchObject({ stdout: `${head}\n`, stderr: '' })
    await expect(
      runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/quiet-probe-absent'])
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' })
  })

  it('combines repository booleans and metadata paths for normal, bare and linked repositories', async () => {
    const probe = [
      'rev-parse',
      '--is-inside-work-tree',
      '--is-bare-repository',
      '--git-dir',
      '--git-common-dir'
    ]
    const main = (await runGit(probe)).stdout.trim().split('\n')
    expect(main).toEqual(['true', 'false', '.git', '.git'])
    await runGit(['init', '--bare', '-q', 'detection-bare.git'])
    const bare = (await runGit(['-C', 'detection-bare.git', ...probe])).stdout.trim().split('\n')
    expect(bare).toEqual(['false', 'true', '.', '.'])
    await runGit(['worktree', 'add', '-q', '-b', 'detection-linked', 'detection-linked'])
    const linked = (await runGit(['-C', 'detection-linked', ...probe])).stdout.trim().split('\n')
    expect(linked.slice(0, 2)).toEqual(['true', 'false'])
    expect(linked[2]).not.toBe(linked[3])
    await expect(runGit(['-C', '.git', ...probe])).resolves.toMatchObject({
      stdout: expect.stringMatching(/^false\nfalse\n/)
    })
  })

  it('distinguishes an absent branch from a ref pointing at a missing object', async () => {
    const missingObject = 'a'.repeat(40)
    const refPath = join(repoPath, '.git', 'refs', 'heads', 'quiet-probe-dangling')
    await writeFile(refPath, `${missingObject}\n`)
    try {
      await expect(
        runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/quiet-probe-dangling'])
      ).resolves.toMatchObject({ stdout: `${missingObject}\n`, stderr: '' })
      await expect(
        runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/quiet-probe-dangling^{commit}'])
      ).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' })
    } finally {
      await rm(refPath)
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
      '--git-common-dir',
      '--git-dir'
    ])
    expect(hasUnsupportedRevParsePathFormatEcho(preferred.stdout)).toBe(!supports(2, 31))
    await expect(
      runGit(['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'])
    ).resolves.toBeDefined()
  })

  // Why pin this: worktree removal decides whether to prune and retry `branch -d` by
  // matching Git's refusal text, and the wording moved inside the supported range
  // (<=2.40 "Cannot delete branch 'x' checked out at", >=2.43 "cannot delete branch 'x'
  // used by worktree at"). It is also the only evidence that the refusal is a stderr
  // message on every supported Git rather than something a caller could read off stdout.
  it('refuses to delete a branch another worktree holds, on stderr, in a recognized wording', async () => {
    await runGit(['worktree', 'add', '-b', 'compat-held', 'held-wt'])
    try {
      const refusal = await runGit(['branch', '-d', '--', 'compat-held']).then(
        () => null,
        (error: unknown) => error
      )
      expect(refusal).not.toBeNull()
      expect(isBranchCheckedOutInWorktreeError(refusal)).toBe(true)
      const streams = refusal as { stdout?: string; stderr?: string }
      expect(streams.stderr ?? '').toMatch(/delete branch .*compat-held/i)
      expect(streams.stdout ?? '').toBe('')
    } finally {
      await runGit(['worktree', 'remove', '--force', 'held-wt'])
      await runGit(['branch', '-D', 'compat-held'])
    }
  })

  it('removes locked prepared worktrees without a separate unlock', async () => {
    await runGit(['worktree', 'add', '--detach', '--no-checkout', 'compat-discard', 'HEAD'])
    await runGit(['-C', 'compat-discard', 'reset', '--hard', 'HEAD'])
    await runGit(['worktree', 'lock', '--reason', 'owned preparation', 'compat-discard'])
    await runGit(['worktree', 'remove', '--force', '--force', 'compat-discard'])
    expect((await runGit(['worktree', 'list', '--porcelain'])).stdout).not.toContain(
      'compat-discard'
    )
  })

  it('supports prepared worktree creation and finalization', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    const lockPath = join(repoPath, '.git', 'worktrees', 'compat-prepared', 'locked')
    const lockReason = 'orca-create-preparation:v1:compat\n'
    try {
      await runGit([
        'worktree',
        'add',
        '--detach',
        '--no-checkout',
        '--lock',
        '--reason',
        lockReason.slice(0, -1),
        'compat-prepared',
        'HEAD'
      ])
      expect(supports(2, 33)).toBe(true)
    } catch (error) {
      expect(supports(2, 33)).toBe(false)
      expect(isUnsupportedWorktreeAddLockReasonError(error)).toBe(true)
      await runGit(['worktree', 'add', '--detach', '--no-checkout', 'compat-prepared', 'HEAD'])
      await writeFile(lockPath, lockReason, { flag: 'wx' })
    }
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockReason)
    await expect(readFile(join(repoPath, 'compat-prepared', 'tracked.txt'))).rejects.toThrow()
    await runGit(['-C', 'compat-prepared', 'reset', '--hard', 'HEAD'])
    const lockPointers = await runGit([
      '-C',
      'compat-prepared',
      'rev-parse',
      '--git-path',
      'locked',
      '--git-common-dir'
    ])
    const pointerLines = lockPointers.stdout.split('\n')
    expect(pointerLines).toHaveLength(3)
    expect(pointerLines[0]?.replace(/\r$/, '').replaceAll('\\', '/')).toMatch(
      /\.git\/worktrees\/compat-prepared\/locked$/
    )
    expect(pointerLines[1]?.replace(/\r$/, '').replaceAll('\\', '/')).toMatch(/(?:^|\/)\.git$/)
    expect(pointerLines[2]).toBe('')
    // Why: `-f -f` moves a locked preparation while preserving its lock reason (Git >=2.25).
    await runGit(['worktree', 'move', '-f', '-f', 'compat-prepared', 'compat-final'])
    await runGit([
      '-C',
      'compat-final',
      'checkout',
      '--no-track',
      '-b',
      'compat-prepared-final',
      head
    ])

    await expect(runGit(['-C', 'compat-final', 'branch', '--show-current'])).resolves.toMatchObject(
      { stdout: 'compat-prepared-final\n' }
    )
    await expect(runGit(['-C', 'compat-final', 'rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${head}\n`
    })
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockReason)
    await unlink(lockPath)
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

  it('writes a multi-pack-index and reads packed objects at the baseline', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['-c', 'gc.auto=0', 'repack', '-d'])
    await expect(runGit(['multi-pack-index', 'write'])).resolves.toBeDefined()
    const midx = await readFile(join(repoPath, '.git', 'objects', 'pack', 'multi-pack-index'))
    expect(midx.subarray(0, 4).toString()).toBe('MIDX')
    await expect(runGit(['multi-pack-index', 'verify'])).resolves.toMatchObject({ stderr: '' })
    await expect(
      runGit(['-c', 'core.multiPackIndex=true', 'cat-file', '-t', head])
    ).resolves.toMatchObject({ stdout: 'commit\n' })
    await runGit(['config', 'core.multiPackIndex', 'false'])
    await expect(
      runGit(['config', '--bool', '--get', 'core.multiPackIndex'])
    ).resolves.toMatchObject({ stdout: 'false\n' })
    await runGit(['config', '--unset', 'core.multiPackIndex'])
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

  it('excludes and includes a directory subtree through the generated pathspecs', async () => {
    await mkdir(join(repoPath, 'vendored'), { recursive: true })
    await writeFile(join(repoPath, 'vendored', 'inner.txt'), 'pathspecneedle\n')
    await writeFile(join(repoPath, 'kept.txt'), 'pathspecneedle\n')
    await runGit(['add', '-A'])
    await runGit(['commit', '-qm', 'pathspec fixture'])

    const listFiles = async (opts: Parameters<typeof buildGitGrepArgs>[1]): Promise<string[]> => {
      const args = buildGitGrepArgs('pathspecneedle', opts).map((arg) =>
        arg === '-n' ? '-l' : arg
      )
      const { stdout } = await runGit(args)
      return stdout.split(/[\0\n]/).filter(Boolean)
    }

    const excluded = await listFiles({ excludePattern: 'vendored' })
    expect(excluded).toContain('kept.txt')
    expect(excluded.some((file) => file.startsWith('vendored/'))).toBe(false)

    const included = await listFiles({ includePattern: 'vendored' })
    expect(included).toEqual(['vendored/inner.txt'])
  })

  // Why pin this: the owner-checkout fast-forward overrides the user's merge settings with flags
  // and `-c` keys; every one must parse on the baseline, and a branch-level `-s ours` must not win.
  it('fast-forwards a checked-out base branch with the exact owner arguments', async () => {
    const worktree = 'compat-ff-wt'
    const branch = 'compat-ff-main'
    const marker = join(repoPath, worktree, 'compat-ff-hook-ran')
    const hookPath = join(repoPath, '.git', 'hooks', 'post-merge')
    await runGit(['worktree', 'add', '-q', '-b', branch, worktree])
    const localOid = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(repoPath, worktree, 'compat-ff-added.txt'), 'upstream\n')
    await runGit(['-C', worktree, 'add', 'compat-ff-added.txt'])
    await runGit(['-C', worktree, 'commit', '-qm', 'upstream'])
    const remoteOid = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['update-ref', `refs/remotes/origin/${branch}`, remoteOid])
    await runGit(['-C', worktree, 'reset', '-q', '--hard', localOid])
    await runGit(['config', `branch.${branch}.mergeOptions`, '-s ours'])
    // Why: an uninstalled source-built Git (the CI baseline) has no templates, so no hooks dir.
    await mkdir(dirname(hookPath), { recursive: true })
    await writeFile(hookPath, '#!/bin/sh\necho ran > compat-ff-hook-ran\n', { mode: 0o755 })
    const merges: string[][] = []
    // Why `-C`: in the Docker lane, paths Git reports are container paths, not host ones.
    const git = {
      exec: (args: string[], cwd: string) => {
        if (args.includes('merge')) {
          merges.push(args)
        }
        return runGit(['-C', cwd, ...args])
      },
      listWorktrees: async (path: string) =>
        parseWorktreeList((await runGit(['-C', path, 'worktree', 'list', '--porcelain'])).stdout)
    }

    try {
      const outcome = await fastForwardLocalBaseBranch(git, {
        repoPath: image ? '/repo' : repoPath,
        fullRef: `refs/heads/${branch}`,
        remoteTrackingRef: `refs/remotes/origin/${branch}`
      })

      expect(outcome).toMatchObject({ status: 'updated' })
      expect(merges).toHaveLength(1)
      await expect(
        runGit(['rev-list', '--parents', '-1', `refs/heads/${branch}`])
      ).resolves.toMatchObject({ stdout: `${remoteOid} ${localOid}\n` })
      await expect(
        readFile(join(repoPath, worktree, 'compat-ff-added.txt'), 'utf-8')
      ).resolves.toBe('upstream\n')
      await expect(readFile(marker, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })

      // Control: the hook and the branch setting are both live for a plain fast-forward.
      await runGit(['-C', worktree, 'reset', '-q', '--hard', localOid])
      await runGit(['-C', worktree, 'merge', '--ff-only', '-q', remoteOid])
      await expect(readFile(marker, 'utf-8')).resolves.toBe('ran\n')
      await expect(runGit(['rev-parse', `refs/heads/${branch}`])).resolves.not.toMatchObject({
        stdout: `${remoteOid}\n`
      })
    } finally {
      await rm(hookPath, { force: true })
      await runGit(['config', '--unset', `branch.${branch}.mergeOptions`])
      await runGit(['worktree', 'remove', '--force', worktree])
    }
  })
  registerGitResolutionBinaryCompatibilityCases(runGit, (name) =>
    image ? `/repo/${name}.git` : join(repoPath, `${name}.git`)
  )
})
