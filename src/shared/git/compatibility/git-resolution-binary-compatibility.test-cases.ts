import { expect, it } from 'vitest'

import {
  resolveDefaultBaseRefViaExec,
  resolveRemoteHeadBranchViaExec
} from '../refs/git-default-base-ref'

export function registerGitResolutionBinaryCompatibilityCases(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>
): void {
  it('resolves default bases from exact refs with symbolic chains and dangling targets', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['update-ref', '-d', 'refs/remotes/origin/main'])
    await runGit(['update-ref', 'refs/remotes/origin/main/topic', head])
    await runGit(['update-ref', 'refs/remotes/origin/master', head])
    await runGit(['update-ref', 'refs/remotes/origin/release/stable', head])
    await runGit([
      'symbolic-ref',
      'refs/remotes/origin/alias',
      'refs/remotes/origin/release/stable'
    ])
    await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/alias'])
    await expect(resolveDefaultBaseRefViaExec(runGit)).resolves.toBe('origin/release/stable')
    await runGit(['update-ref', '-d', 'refs/remotes/origin/release/stable'])
    await expect(resolveDefaultBaseRefViaExec(runGit)).resolves.toBe('origin/master')
    await runGit(['update-ref', '--no-deref', 'refs/remotes/origin/HEAD', head])
    await expect(resolveDefaultBaseRefViaExec(runGit)).resolves.toBe('origin/master')
  })

  it('resolves each remote HEAD independently with Git 2.25-compatible ref output', async () => {
    const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(['update-ref', 'refs/remotes/origin/review-main', head])
    await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/review-main'])
    await runGit(['update-ref', 'refs/remotes/upstream/release/stable', head])
    await runGit([
      'symbolic-ref',
      'refs/remotes/upstream/alias',
      'refs/remotes/upstream/release/stable'
    ])
    await runGit(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/alias'])
    await expect(resolveRemoteHeadBranchViaExec(runGit, 'origin')).resolves.toBe('review-main')
    await expect(resolveRemoteHeadBranchViaExec(runGit, 'upstream')).resolves.toBe('release/stable')
    await expect(resolveRemoteHeadBranchViaExec(runGit, 'missing')).resolves.toBeNull()
    await runGit(['update-ref', '-d', 'refs/remotes/upstream/release/stable'])
    await expect(resolveRemoteHeadBranchViaExec(runGit, 'upstream')).resolves.toBeNull()
  })
}
