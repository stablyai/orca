import { expect, it, vi } from 'vitest'
import { readCurrentGitBranchName } from './git-current-branch'

it.each(['feature', 'heads/feature', 'Feature'])(
  'retains canonical identity %s',
  async (branch) => {
    const run = vi.fn().mockResolvedValue({ stdout: `refs/heads/${branch}\n` })
    expect(await readCurrentGitBranchName(run)).toBe(branch)
    expect(run).toHaveBeenCalledWith(['symbolic-ref', '--quiet', 'HEAD'])
  }
)

it.each(['refs/tags/feature', 'feature', 'refs/heads/', ''])(
  'rejects non-branch identity %s',
  async (stdout) => {
    expect(await readCurrentGitBranchName(async () => ({ stdout }))).toBeNull()
  }
)

it('distinguishes detached HEAD from execution failure', async () => {
  const run = vi.fn().mockRejectedValueOnce({ code: 1 }).mockRejectedValueOnce({ code: 128 })
  expect(await readCurrentGitBranchName(run)).toBeNull()
  await expect(readCurrentGitBranchName(run)).rejects.toEqual({ code: 128 })
})
