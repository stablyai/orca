import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveEffectiveGitUpstream, type GitCommandRunner } from './git-effective-upstream'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Publishes `branchName` to a real local remote without `-u`, so the
 * remote-tracking ref exists but no `branch.<name>.merge` is configured. That
 * is the state Orca's "Publish Branch" leaves behind, and it forces upstream
 * resolution through the current-branch-name path this module owns.
 */
async function createRepoWithPublishedBranch(branchName: string): Promise<GitCommandRunner> {
  const root = await mkdtemp(join(tmpdir(), 'orca-effective-upstream-'))
  tempDirs.push(root)
  const repoPath = join(root, 'repo')
  const remotePath = join(root, 'remote.git')
  await execFileAsync('git', ['init', '--quiet', '--bare', remotePath])
  await execFileAsync('git', ['init', '--quiet', repoPath])
  const runGit: GitCommandRunner = async (args) => execFileAsync('git', args, { cwd: repoPath })
  await runGit(['config', 'user.email', 'test@example.com'])
  await runGit(['config', 'user.name', 'Orca Test'])
  await runGit(['commit', '--quiet', '--allow-empty', '-m', 'init'])
  await runGit(['remote', 'add', 'origin', remotePath])
  await runGit(['checkout', '--quiet', '-b', branchName])
  await runGit(['push', '--quiet', 'origin', branchName])
  return runGit
}

describe('resolveEffectiveGitUpstream against real git', () => {
  it('resolves the upstream when a same-named tag makes the branch ref ambiguous', async () => {
    const runGit = await createRepoWithPublishedBranch('v1.0')
    // Why: `--short` abbreviates to the shortest *unambiguous* ref, so a
    // same-named tag turns the branch into `heads/v1.0` — a name no
    // `branch.<name>.*` config key or remote-tracking ref ever matches.
    await runGit(['tag', 'v1.0'])

    await expect(resolveEffectiveGitUpstream(runGit)).resolves.toEqual({
      upstreamName: 'origin/v1.0',
      remoteName: 'origin',
      branchName: 'v1.0',
      isConfiguredUpstream: false
    })
  }, 30_000)

  it.each([
    ['ASCII', 'feature/plain-ascii-branch'],
    ['Korean', 'egoing/AGENTS.md-를-생성하고-위키-정책을-수립하기'],
    ['Japanese', 'テスト-ブランチ-日本語'],
    ['Chinese', '中文分支名称测试'],
    ['Cyrillic', 'кириллица-ветка'],
    ['emoji', 'emoji-🎉-branch'],
    ['double quote', 'has"quote']
  ])(
    'round-trips a %s branch name byte-for-byte',
    async (_label, branchName) => {
      const runGit = await createRepoWithPublishedBranch(branchName)

      const upstream = await resolveEffectiveGitUpstream(runGit)

      expect(upstream?.branchName).toBe(branchName)
      expect(upstream?.upstreamName).toBe(`origin/${branchName}`)
    },
    30_000
  )

  it('reports no upstream on a detached HEAD', async () => {
    const runGit = await createRepoWithPublishedBranch('detached-probe')
    await runGit(['checkout', '--quiet', '--detach', 'HEAD'])

    await expect(resolveEffectiveGitUpstream(runGit)).resolves.toBeNull()
  }, 30_000)
})

describe('resolveEffectiveGitUpstream', () => {
  it('reads the full HEAD ref rather than the abbreviated form', async () => {
    const branchName = 'egoing/AGENTS.md-를-생성하고-위키-정책을-수립하기'
    const runGit: GitCommandRunner = async (args) => {
      if (args[0] === 'symbolic-ref') {
        // Why: `--short` can abbreviate away from the real branch name, which
        // every downstream `branch.<name>.*` lookup is keyed by.
        expect(args).toEqual(['symbolic-ref', '--quiet', 'HEAD'])
        return { stdout: `refs/heads/${branchName}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(
          "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree."
        )
      }
      if (args[0] === 'config') {
        const key = args.at(-1)
        if (key === `branch.${branchName}.remote`) {
          return { stdout: 'origin\n' }
        }
        if (key === `branch.${branchName}.merge`) {
          return { stdout: `refs/heads/${branchName}\n` }
        }
        throw new Error('fatal: key not found')
      }
      if (args[0] === 'rev-parse' && args.at(-1) === `refs/remotes/origin/${branchName}`) {
        return { stdout: 'deadbeef\n' }
      }
      throw new Error(`unexpected git invocation: ${JSON.stringify(args)}`)
    }

    await expect(resolveEffectiveGitUpstream(runGit)).resolves.toEqual({
      upstreamName: `origin/${branchName}`,
      remoteName: 'origin',
      branchName,
      isConfiguredUpstream: false
    })
  })
})
