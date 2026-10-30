import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { parseWorktreeList } from './git-worktree-porcelain-parser'
import { fastForwardLocalBaseBranch } from './worktree/local-base-branch-fast-forward'

export function registerGitLocalBaseBranchBinaryCompatibilityCase(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  getRepoPath: () => string,
  usesContainer: boolean
): void {
  // Pin baseline parsing of owner fast-forward flags/config; user branch mergeOptions such as -s ours must not override them.
  it('fast-forwards a checked-out base branch with the exact owner arguments', async () => {
    const repoPath = getRepoPath()
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
        repoPath: usesContainer ? '/repo' : repoPath,
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
}
