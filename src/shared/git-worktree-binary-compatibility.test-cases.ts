import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isBranchCheckedOutInWorktreeError } from './git-branch-delete-refusal'
import { createGitProgressRecordReader, type GitProgressRecord } from './git-progress-records'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedWorktreeAddLockReasonError,
  isUnsupportedWorktreeListZError
} from './git-worktree-command-capabilities'

export function registerGitWorktreeBinaryCompatibilityCases(
  runGit: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>,
  resolveRepoPath: () => string,
  supports: (major: number, minor: number) => boolean,
  expectPreferredOrRecognizedFallback: (
    args: string[],
    expectedSupport: boolean,
    recognizesUnsupported: (error: unknown) => boolean
  ) => Promise<void>
): void {
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
    await rm(join(resolveRepoPath(), 'stale-wt'), { recursive: true, force: true })
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

  // Why pin this: the create card reads the checkout meter `worktree add` writes into a pipe
  // unasked (it has no --progress flag), so the record format is a contract with every Git.
  it('writes checkout progress records into a pipe during worktree add', async () => {
    const fileCount = 120
    const source = join(resolveRepoPath(), 'progress-source')
    await mkdir(source)
    try {
      await Promise.all(
        Array.from({ length: fileCount }, (_, index) =>
          writeFile(join(source, `file-${index}.txt`), `${index}\n`)
        )
      )
      await runGit(['-C', 'progress-source', 'init', '-q'])
      await runGit(['-C', 'progress-source', 'add', '.'])
      await runGit([
        '-C',
        'progress-source',
        '-c',
        'user.name=Compatibility Test',
        '-c',
        'user.email=compatibility@example.invalid',
        'commit',
        '-qm',
        'files'
      ])
      // Why the env: git otherwise waits ~1 s before its first record, longer than this checkout.
      const { stderr } = await runGit(
        ['-C', 'progress-source', 'worktree', 'add', '-b', 'compat-progress', '../progress-wt'],
        { GIT_PROGRESS_DELAY: '0' }
      )
      const records: GitProgressRecord[] = []
      createGitProgressRecordReader('Updating files', (record) => records.push(record))(stderr)

      expect(records.length).toBeGreaterThan(1)
      expect(records.at(-1)).toEqual({
        percent: 100,
        completed: fileCount,
        total: fileCount,
        done: true
      })
      const completed = records.map((record) => record.completed)
      expect(completed).toEqual([...completed].sort((left, right) => left - right))
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(join(resolveRepoPath(), 'progress-wt'), { recursive: true, force: true })
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
    const lockPath = join(resolveRepoPath(), '.git', 'worktrees', 'compat-prepared', 'locked')
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
    await expect(
      readFile(join(resolveRepoPath(), 'compat-prepared', 'tracked.txt'))
    ).rejects.toThrow()
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
}
