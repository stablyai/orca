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

const execFileAsync = promisify(execFile)
const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const describeBinaryCompatibility = image || binary ? describe : describe.skip

type GitResult = { stdout: string; stderr: string }

describeBinaryCompatibility('real Git binary compatibility', () => {
  let repoPath = ''
  let version = { major: 0, minor: 0 }

  async function runGit(args: string[]): Promise<GitResult> {
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
    return execFileAsync(binary!, args, { cwd: repoPath, maxBuffer: 2 * 1024 * 1024 })
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
})
