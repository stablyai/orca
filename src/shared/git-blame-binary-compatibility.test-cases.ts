import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildGitBlameArgs } from './git-blame-args'
import { findGitBlameHunkForLine, parseGitBlamePorcelain } from './git-blame-porcelain-parser'

export function registerGitBlameBinaryCompatibilityCase(
  runGit: (
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ) => Promise<{ stdout: string; stderr: string }>,
  getRepoPath: () => string
): void {
  // Why pin this: the editor blames unsaved buffers through `--contents -`, which must parse on the baseline.
  it('blames a committed file and a stdin buffer with the editor argv', async () => {
    await writeFile(join(getRepoPath(), 'compat-blame.txt'), 'kept\n')
    await runGit(['add', 'compat-blame.txt'])
    await runGit(['commit', '-qm', 'compat blame'])

    const committed = parseGitBlamePorcelain(
      (await runGit(buildGitBlameArgs('compat-blame.txt', false))).stdout
    )
    const committedHunk = findGitBlameHunkForLine(committed.hunks, 1)
    expect(committedHunk && committed.commits[committedHunk.sha]).toMatchObject({
      author: 'Compatibility Test',
      summary: 'compat blame',
      uncommitted: false
    })

    const buffer = parseGitBlamePorcelain(
      (await runGit(buildGitBlameArgs('compat-blame.txt', true), undefined, 'added\nkept\n')).stdout
    )
    const addedHunk = findGitBlameHunkForLine(buffer.hunks, 1)
    const keptHunk = findGitBlameHunkForLine(buffer.hunks, 2)
    expect(addedHunk && buffer.commits[addedHunk.sha]?.uncommitted).toBe(true)
    expect(keptHunk?.sha).toBe(committedHunk?.sha)
  })
}
