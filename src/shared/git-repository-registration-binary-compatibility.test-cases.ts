import { mkdir, rm } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { expect, it } from 'vitest'

export function registerGitRepositoryRegistrationBinaryCompatibilityCase(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  getRepoPath: () => string,
  image: boolean
): void {
  it('supports repository registration probes for nested, linked and bare repositories', async () => {
    const repoPath = getRepoPath()
    const executionRoot = image ? '/repo' : repoPath
    const nested = join(repoPath, 'registration nested')
    const linked = image ? '/repo/registration linked' : join(repoPath, 'registration linked')
    const bare = image ? '/repo/registration bare' : join(repoPath, 'registration bare')
    await mkdir(nested)
    await runGit(['worktree', 'add', '-b', 'registration-linked', linked])
    await runGit(['init', '--bare', bare])
    try {
      const root = (await runGit(['rev-parse', '--show-toplevel'])).stdout.trim()
      const linkedRoot = (
        await runGit(['-C', linked, 'rev-parse', '--show-toplevel'])
      ).stdout.trim()
      for (const cwd of [executionRoot, image ? '/repo/registration nested' : nested, linked]) {
        expect(
          (await runGit(['-C', cwd, 'rev-parse', '--is-inside-work-tree', '--is-bare-repository']))
            .stdout
        ).toBe('true\nfalse\n')
        const records = (
          await runGit([
            '-C',
            cwd,
            'rev-parse',
            '--is-inside-work-tree',
            '--show-toplevel',
            '--git-dir',
            '--git-common-dir'
          ])
        ).stdout
          .trim()
          .split('\n')
        expect(records).toHaveLength(4)
        expect(records[0]).toBe('true')
        expect(records[1]).toBe(cwd === linked ? linkedRoot : root)
        const resolveDirectory = image ? posix.resolve : resolve
        expect(resolveDirectory(cwd, records[2]) === resolveDirectory(cwd, records[3])).toBe(
          cwd !== linked
        )
      }
      expect(
        (await runGit(['-C', bare, 'rev-parse', '--is-inside-work-tree', '--is-bare-repository']))
          .stdout
      ).toBe('false\ntrue\n')
    } finally {
      await runGit(['worktree', 'remove', '--force', linked])
      await rm(nested, { recursive: true, force: true })
      await rm(join(repoPath, 'registration bare'), { recursive: true, force: true })
    }
  })
}
