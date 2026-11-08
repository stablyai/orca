import { expect, it } from 'vitest'
import { isBranchCheckedOutInWorktreeError } from '../branches/git-branch-delete-refusal'

export function registerGitWorktreeBinaryCompatibilityCases(
  runGit: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>
): void {
  // Pin stderr refusal recognition across <=2.40 checked-out-at and >=2.43 used-by-worktree-at wording; removal uses it to prune/retry.
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

  // The create card consumes worktree add’s unrequested piped checkout meter; pin its format across supported Git.

  // Retarget drift parsing fails closed on shape changes; commit-tree builds fixtures without leaving refs/worktrees.
}
