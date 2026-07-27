import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GIT_CURRENT_BRANCH_REF_ARGS,
  branchNameFromHeadRef,
  readGitCurrentBranchName
} from './git-current-branch-name'
import { loadGitHistoryFromExecutor } from './git-history'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Repo = {
  repoPath: string
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>
}

/**
 * Repo on branch `v1.0` tracking a contributor `fork`, with a `v1.0` tag that
 * makes the branch ref ambiguous. This is the PR-review worktree shape where a
 * wrong branch name sends commits to the wrong repository.
 */
async function createAmbiguousForkTrackingRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'orca-current-branch-'))
  tempDirs.push(root)
  const repoPath = join(root, 'repo')
  const globalConfigPath = join(root, 'global-gitconfig')
  await writeFile(globalConfigPath, '')
  // Why: pin config so a developer's global gitconfig cannot change the outcome.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath, GIT_CONFIG_NOSYSTEM: '1' }
  await execFileAsync('git', ['init', '--quiet', '--bare', join(root, 'origin.git')], { env })
  await execFileAsync('git', ['init', '--quiet', '--bare', join(root, 'fork.git')], { env })
  await execFileAsync('git', ['init', '--quiet', repoPath], { env })
  const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('git', args, { cwd: repoPath, env })
  await runGit(['config', 'user.email', 'test@example.com'])
  await runGit(['config', 'user.name', 'Orca Test'])
  await runGit(['commit', '--quiet', '--allow-empty', '-m', 'init'])
  await runGit(['remote', 'add', 'origin', join(root, 'origin.git')])
  await runGit(['remote', 'add', 'fork', join(root, 'fork.git')])
  await runGit(['checkout', '--quiet', '-b', 'v1.0'])
  await runGit(['push', '--quiet', '-u', 'fork', 'v1.0'])
  await runGit(['tag', 'v1.0'])
  return { repoPath, runGit }
}

describe('branchNameFromHeadRef', () => {
  it('strips only the refs/heads/ prefix', () => {
    expect(branchNameFromHeadRef('refs/heads/v1.0\n')).toBe('v1.0')
    expect(branchNameFromHeadRef('refs/heads/feature/nested\n')).toBe('feature/nested')
    // A branch literally named `heads/v2.0` lives at refs/heads/heads/v2.0.
    expect(branchNameFromHeadRef('refs/heads/heads/v2.0\n')).toBe('heads/v2.0')
    expect(branchNameFromHeadRef('refs/heads/wip/refs/heads/x\n')).toBe('wip/refs/heads/x')
  })

  it('treats a HEAD symref outside refs/heads/ as detached', () => {
    // Callers key branch config and ref paths by this value; returning the raw
    // symref fabricates lookups like refs/heads/refs/custom/thing and can match
    // a bogus upstream. git rejects the state too: "HEAD not found below refs/heads!".
    expect(branchNameFromHeadRef('refs/custom/thing\n')).toBeNull()
    expect(branchNameFromHeadRef('refs/tags/v1.0\n')).toBeNull()
    expect(branchNameFromHeadRef('refs/heads/\n')).toBeNull()
  })

  it('treats empty output as no branch', () => {
    expect(branchNameFromHeadRef('')).toBeNull()
    expect(branchNameFromHeadRef('  \n')).toBeNull()
  })

  it('never reads the abbreviated form', () => {
    expect(GIT_CURRENT_BRANCH_REF_ARGS).not.toContain('--short')
  })
})

describe('readGitCurrentBranchName against real git', () => {
  it('returns the exact branch name when a same-named tag makes HEAD ambiguous', async () => {
    const { runGit } = await createAmbiguousForkTrackingRepo()

    // Proves the repo really is ambiguous rather than the assertion passing vacuously.
    const abbreviated = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
    expect(abbreviated).toBe('heads/v1.0')

    await expect(readGitCurrentBranchName(runGit)).resolves.toBe('v1.0')
  }, 30_000)

  it('returns null on a detached HEAD', async () => {
    const { runGit } = await createAmbiguousForkTrackingRepo()
    await runGit(['checkout', '--quiet', '--detach', 'HEAD'])

    await expect(readGitCurrentBranchName(runGit)).resolves.toBeNull()
  }, 30_000)
})

describe('ambiguous-ref regressions in current-branch consumers', () => {
  it('reports the branch and its fork upstream in git history', async () => {
    const { repoPath, runGit } = await createAmbiguousForkTrackingRepo()

    const history = await loadGitHistoryFromExecutor((args) => runGit(args), repoPath, {})

    // Why: on `--short` the current ref became `refs/heads/heads/v1.0` (a ref that
    // does not exist) and the upstream lookup returned undefined, so the history
    // panel lost incoming/outgoing change detection entirely.
    expect(history.currentRef).toMatchObject({ id: 'refs/heads/v1.0', name: 'v1.0' })
    expect(history.remoteRef).toMatchObject({ name: 'fork/v1.0' })
  }, 30_000)
})
