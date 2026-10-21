import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from './git-merge-tree-capability'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from './git-capability-cache'
import {
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX
} from './git-object-quarantine'
import { isForEachRefExcludeUnsupportedError } from './git-ref-command-capabilities'
import { isNoWriteFetchHeadUnsupportedError } from './git-fetch-head-capability'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'
import { buildGitGrepArgs } from './text-search'
import { parseGitRemoteFetchUrls } from './git-remote-url-index'
import { GIT_HISTORY_COMMIT_FORMAT, parseGitHistoryLog } from './git-history-log-parser'
import {
  githubPullRequestHeadLocalRef,
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from './review-head-tracking-ref'
import { gitChangeListArgs, parseGitChangeList } from './git-change-list'
import { encodeGitPathspecs } from './git-pathspec-stdin'
import { GitBinaryTestFixture } from './git-binary.test-fixture'
import { registerGitRepositoryRegistrationBinaryCompatibilityCase } from './git-repository-registration-binary-compatibility.test-cases'
import { registerGitLocalBaseBranchBinaryCompatibilityCase } from './git-local-base-branch-binary-compatibility.test-cases'
import { registerGitResolutionBinaryCompatibilityCases } from './git-resolution-binary-compatibility.test-cases'
import { registerGitWorktreeBinaryCompatibilityCases } from './git-worktree-binary-compatibility.test-cases'

const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const describeBinaryCompatibility = image || binary ? describe : describe.skip

type GitResult = { stdout: string; stderr: string }

describeBinaryCompatibility('real Git binary compatibility', () => {
  let repoPath = ''
  let fixture: GitBinaryTestFixture
  let version = { major: 0, minor: 0 }

  async function runGit(
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ): Promise<GitResult> {
    return fixture.exec(args, fixture.executionRoot, env, stdin)
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
    repoPath = await realpath(await mkdtemp(join(tmpdir(), 'orca-git-binary-compat-')))
    fixture = new GitBinaryTestFixture(repoPath, '/repo')
    await fixture.start()
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
      try {
        await fixture.stop()
      } finally {
        await rm(repoPath, { recursive: true, force: true })
      }
    }
  })

  registerGitRepositoryRegistrationBinaryCompatibilityCase(runGit, () => repoPath, Boolean(image))

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

  registerGitWorktreeBinaryCompatibilityCases(
    runGit,
    () => repoPath,
    supports,
    expectPreferredOrRecognizedFallback
  )

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

  // Why pin this: a scratch folder made around a Git that rejects --write-tree can outlive a crash,
  // and Git before 2.35 never prunes it; only a Git known to write trees gets one.
  it('makes a merge-tree scratch object store only once this Git is known to write trees', async () => {
    const branch = 'compat-cleanup-merged'
    await runGit(['branch', branch, 'HEAD'])
    const objectsPath = join(repoPath, '.git', 'objects')
    const quarantine = createGitObjectQuarantine(async () => ({
      hostPath: objectsPath,
      gitPath: image ? '/repo/.git/objects' : objectsPath
    }))
    let scratchFolders = 0
    const runCleanupGit: GitBranchCleanupExec = (args, options) =>
      options?.discardWrittenObjects
        ? quarantine.run((env) => {
            scratchFolders += env ? 1 : 0
            return runGit(args, env)
          })
        : runGit(args)
    const capabilities = new GitCapabilityCache()
    const check = () =>
      branchHasNoUnmergedChangesOnAnyTarget(runCleanupGit, branch, ['HEAD'], capabilities)

    try {
      await expect(check()).resolves.toBe(supports(2, 38))
      await expect(check()).resolves.toBe(supports(2, 38))
      expect(scratchFolders).toBe(supports(2, 38) ? 1 : 0)
      expect(
        (await readdir(objectsPath)).filter((entry) =>
          entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX)
        )
      ).toEqual([])
    } finally {
      await runGit(['branch', '-D', branch])
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

  registerGitLocalBaseBranchBinaryCompatibilityCase(runGit, () => repoPath, Boolean(image))
  registerGitResolutionBinaryCompatibilityCases(runGit, (name) =>
    image ? `/repo/${name}.git` : join(repoPath, `${name}.git`)
  )
})
