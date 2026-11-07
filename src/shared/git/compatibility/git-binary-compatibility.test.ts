import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as gitRunner from '../../../main/git/command-runner/git-exec-file'
import { getRemoteFileUrl } from '../../../main/git/repo'
import { refreshBranchCleanupTargetRefs } from '../branches/git-branch-cleanup-fetch'
import { buildGitGrepArgs } from '../../text-search'
import { parseGitRemoteFetchUrls } from '../remotes/git-remote-url-index'
import { GIT_HISTORY_COMMIT_FORMAT, parseGitHistoryLog } from '../history/git-history-log-parser'
import { GitBinaryTestFixture } from './git-binary.test-fixture'
import { registerGitLocalBaseBranchBinaryCompatibilityCase } from './git-local-base-branch-binary-compatibility.test-cases'
import { registerGitResolutionBinaryCompatibilityCases } from './git-resolution-binary-compatibility.test-cases'
import { registerGitWorktreeBinaryCompatibilityCases } from '../worktrees/git-worktree-binary-compatibility.test-cases'

const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const describeBinaryCompatibility = image || binary ? describe : describe.skip
const PAIRS_REFS_TEST =
  'pairs published, tracked and default refs with configured repositories, on the selected Git binary'

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

  // Each Git call is a docker exec: image runs take 22-25 s of a 30 s default, so loaded runners tripped it.
  it(PAIRS_REFS_TEST, { timeout: image ? 90_000 : undefined }, async () => {
    const root = join(repoPath, 'copy-url')
    await mkdir(root)
    const cwd = image ? '/repo/copy-url' : root
    const git = (...args: string[]) => runGit(['-C', cwd, ...args])
    let overflow = false
    const exec = vi
      .spyOn(gitRunner, 'gitExecFileAsync')
      .mockImplementation(async (args, options) => {
        const result = await git(...args)
        if (args[0] === 'for-each-ref' && !args.some((arg) => arg.startsWith('--contains='))) {
          expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024)
        }
        if (Buffer.byteLength(result.stdout) > (options?.maxBuffer ?? Infinity)) {
          overflow = true
          throw new Error('stdout exceeded maxBuffer')
        }
        return result
      })
    try {
      const url = (ref: string | null, remote = 'origin', path = root) =>
        expect(getRemoteFileUrl(path, 'a b.ts', 10, 20)).resolves.toBe(
          ref === null
            ? null
            : `https://github.com/org/${remote}/blob/${encodeURIComponent(ref)}/a%20b.ts#L10-L20`
        )
      await url(null) // Non-Git folder.
      await git('init', '-q')
      await git('symbolic-ref', 'HEAD', 'refs/heads/main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.invalid')
      await git('config', 'core.hooksPath', join(root, 'no-hooks'))
      await git('remote', 'add', 'origin', 'https://github.com/org/origin.git')
      await url(null) // Unborn.
      await git('-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'base')
      const base = (await git('rev-parse', 'HEAD')).stdout.trim()
      await git('update-ref', 'refs/remotes/origin/main', base)
      await git('checkout', '-qb', 'feature/local')
      await git('-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'feature')
      const head = (await git('rev-parse', 'HEAD')).stdout.trim()
      await url('main')
      const forkFetchConfig = 'remote.team/fork.x.fetch'
      const publicationRef = 'refs/remotes/origin/published'
      await git('remote', 'add', 'team/fork.x', 'https://github.com/org/team-fork.git')
      for (const [mapping, destination] of [
        ['+refs/heads/review-*:refs/cache/published-*', 'refs/cache/published-feature'],
        ['+refs/heads/*:refs/c*end', 'refs/cache/team/feature-end']
      ]) {
        await git('config', forkFetchConfig, mapping)
        await git('update-ref', destination, head)
        await url(head, 'team-fork')
        await git('update-ref', '-d', destination)
      }
      await git('config', forkFetchConfig, '+refs/heads/review/*:refs/hosting-cache/*')
      await git('update-ref', 'refs/hosting-cache/topic', base)
      await git('config', 'branch.feature/local.remote', 'team/fork.x')
      await git('config', 'branch.feature/local.merge', 'refs/heads/review/topic')
      await url('review/topic', 'team-fork')
      const tree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim()
      const descendant = (await git('commit-tree', tree, '-p', head, '-m', 'later')).stdout.trim()
      for (const [destination, tip, remote] of [
        [publicationRef, head, 'origin'], // Publication elsewhere beats an ahead upstream.
        ['refs/hosting-cache/topic', head, 'team-fork'], // Upstream wins ties.
        ['refs/hosting-cache/topic', descendant, 'team-fork'] // Contains an ancestor.
      ]) {
        await git('update-ref', destination, tip)
        await url(head, remote)
      }
      await git('remote', 'remove', 'origin')
      await git('checkout', '--detach', '-q')
      await url(head, 'team-fork') // Detached, no origin, custom destination.
      await git('update-ref', 'refs/hosting-cache/topic', base)
      await git('symbolic-ref', 'refs/remotes/team/fork.x/HEAD', 'refs/hosting-cache/topic')
      await url('review/topic', 'team-fork') // Mapped named default.
      await git('remote', 'add', 'origin', 'https://github.com/org/origin.git')
      await git('config', 'remote.origin.fetch', '+refs/heads/review/*:refs/remotes/origin/*')
      await git('update-ref', 'refs/remotes/origin/main', base)
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      await url('review/main') // Mapped origin default, never destination suffix.
      await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/origin-cache/*')
      await git('config', forkFetchConfig, `+refs/heads/published:${publicationRef}`)
      await git('update-ref', publicationRef, head)
      await url(head, 'team-fork') // Origin-looking destination belongs to fork.
      await git('remote', 'add', 'unsupported', '/unhosted.git')
      await git('config', 'remote.unsupported.fetch', `+refs/heads/other:${publicationRef}`)
      await url(null) // Unsupported owner still makes attribution ambiguous.
      await git('remote', 'remove', 'unsupported')
      await git('config', '--add', forkFetchConfig, `+refs/heads/other:${publicationRef}`)
      await url(null) // Ambiguity inside one remote cannot disappear.
      await git('config', '--unset-all', forkFetchConfig)
      await git('config', forkFetchConfig, '+refs/heads/review/*:refs/hosting-cache/*')
      await git('checkout', '-q', 'feature/local')
      await git('update-ref', '-d', 'refs/hosting-cache/topic')
      await git('update-ref', 'refs/hosting-cache/topic/descendant', base)
      await url(null) // Descendants prove neither upstream nor dangling default target exists.
      await git('update-ref', '-d', 'refs/hosting-cache/topic/descendant')
      await git('config', 'branch.feature/local.remote', '.')
      await git('config', 'branch.feature/local.merge', 'refs/heads/main')
      await url(null)
      if (supports(2, 29)) {
        await git('update-ref', 'refs/hosting-cache/topic', head)
        await git('config', '--add', forkFetchConfig, '^refs/heads/review/topic')
        await url(null)
      }
      await git('remote', 'remove', 'team/fork.x')
      await git('remote', 'set-url', 'origin', '/unhosted.git')
      await url(null) // No supported URL.
      await git('remote', 'set-url', 'origin', 'https://github.com/org/origin.git')
      await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      await git('update-ref', 'refs/remotes/origin/main', base)
      await git('update-ref', '-d', publicationRef)
      for (const tip of [base, head, base]) {
        await runGit(
          ['-C', cwd, 'update-ref', '--stdin'],
          undefined,
          Array.from(
            { length: 4500 },
            (_, i) => `update refs/remotes/origin/${'x'.repeat(220)}${i} ${tip}\n`
          ).join('')
        )
        overflow = false
        await url('main')
        expect(overflow).toBe(tip === head)
      }
      const counts: number[] = []
      for (const n of [10, 100]) {
        for (let i = counts.length ? 10 : 0; i < n; i++) {
          await git('remote', 'add', `r${i}`, `https://github.com/org/r${i}.git`)
          await git('update-ref', `refs/remotes/r${i}/main`, head)
        }
        await git('symbolic-ref', 'refs/remotes/r0/HEAD', 'refs/remotes/r0/main')
        exec.mockClear()
        await url(head, 'r0')
        counts.push(exec.mock.calls.length)
      }
      expect(counts).toEqual([7, 7])
      await mkdir(join(root, 'linked'))
      await git('worktree', 'add', '--detach', join(cwd, 'linked'), head)
      exec.mockImplementation((args) => runGit(['-C', join(cwd, 'linked'), ...args]))
      await url(head, 'r0', join(root, 'linked'))
    } finally {
      exec.mockRestore()
    }
  })

  registerGitWorktreeBinaryCompatibilityCases(runGit)

  // remote -v must match get-url’s insteadOf-expanded first fetch URL across supported Git versions; raw config is insufficient.
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

  it('refreshes a cleanup base with maintenance disabled and an explicit refspec', async () => {
    const branch = 'compat-cleanup-source'
    const remote = 'compat-cleanup'
    const target = `refs/remotes/${remote}/${branch}`
    await runGit(['branch', branch, 'HEAD'])
    await runGit(['remote', 'add', remote, '.'])
    try {
      await expect(
        refreshBranchCleanupTargetRefs((args) => runGit(args), [target])
      ).resolves.toEqual([target])
      expect((await runGit(['rev-parse', target])).stdout).toBe(
        (await runGit(['rev-parse', branch])).stdout
      )
    } finally {
      await runGit(['remote', 'remove', remote])
      await runGit(['branch', '-D', branch])
    }
  })

  // Unsupported --write-tree may leave crash debris that Git <2.35 cannot prune; create scratch stores only after support is known.

  // Git 2.25–2.49 echoes --end-of-options with --symbolic-full-name but consumes it with --verify; git-history skips the echoed line.

  // Pinned SSH branch diffs require show <oid>:<path> to use that commit and reject missing paths; failure represents additions/deletions.

  // Older Git echoes %(decorate:...) with exit 0; %D in the same record must recover badges (#15507).
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
