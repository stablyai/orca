import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorktreeList } from '../git-worktree-porcelain-parser'
import {
  fastForwardLocalBaseBranch,
  type LocalBaseBranchGit
} from './local-base-branch-fast-forward'

const tempRoots: string[] = []

// Why: keep the user's global/system config (hooksPath, autocrlf, signing) out of these repos.
function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig')
  }
}

type Fixture = {
  repoPath: string
  env: NodeJS.ProcessEnv
  localOid: string
  remoteOid: string
  git: (args: string[], cwd?: string) => string
}

// `main` is checked out one commit behind `refs/remotes/origin/main`, which edits version.txt and adds added.txt.
async function createBehindRepo(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-local-base-ff-'))
  tempRoots.push(root)
  await writeFile(join(root, 'empty-gitconfig'), '')
  const env = isolatedGitEnv(root)
  const repoPath = join(root, 'repo')
  const git = (args: string[], cwd = repoPath) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(['init', '--quiet', repoPath], root)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(['add', 'version.txt'])
  git(['commit', '--quiet', '-m', 'one'])
  const localOid = git(['rev-parse', 'HEAD'])
  git(['checkout', '--quiet', '-b', 'upstream'])
  await writeFile(join(repoPath, 'version.txt'), 'two\n')
  await writeFile(join(repoPath, 'added.txt'), 'from upstream\n')
  git(['add', 'version.txt', 'added.txt'])
  git(['commit', '--quiet', '-m', 'two'])
  const remoteOid = git(['rev-parse', 'HEAD'])
  git(['checkout', '--quiet', 'main'])
  git(['update-ref', 'refs/remotes/origin/main', remoteOid])
  git(['branch', '--quiet', '-D', 'upstream'])
  return { repoPath, env, localOid, remoteOid, git }
}

/** Real git; `beforeMerge` runs just before the owner fast-forward, after the inspection passed. */
function realGit(fixture: Fixture, beforeMerge?: () => Promise<void> | void) {
  let merges = 0
  const run = (args: string[], cwd: string) =>
    new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('git', args, { cwd, env: fixture.env, encoding: 'utf8' }, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout })
      )
    })
  const git: LocalBaseBranchGit = {
    exec: async (args, cwd) => {
      if (args.includes('merge')) {
        merges += 1
        await beforeMerge?.()
      }
      return run(args, cwd)
    },
    listWorktrees: async (repoPath) =>
      parseWorktreeList((await run(['worktree', 'list', '--porcelain'], repoPath)).stdout)
  }
  return { git, merges: () => merges }
}

function fastForward(fixture: Fixture, git: LocalBaseBranchGit) {
  return fastForwardLocalBaseBranch(git, {
    repoPath: fixture.repoPath,
    fullRef: 'refs/heads/main',
    remoteTrackingRef: 'refs/remotes/origin/main'
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fastForwardLocalBaseBranch against real Git', () => {
  it('leaves an untracked file at a path the new commit adds, and does not move main', async () => {
    const fixture = await createBehindRepo()
    await writeFile(join(fixture.repoPath, 'added.txt'), 'my notes\n')

    const outcome = await fastForward(fixture, realGit(fixture).git)

    expect(outcome.status).toBe('skipped_dirty_worktree')
    expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('my notes\n')
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
  })

  it('leaves an ignored file at a path the new commit adds, and does not move main', async () => {
    const fixture = await createBehindRepo()
    await writeFile(join(fixture.repoPath, '.git', 'info', 'exclude'), 'added.txt\n')
    await writeFile(join(fixture.repoPath, 'added.txt'), 'SECRET=mine\n')

    const outcome = await fastForward(fixture, realGit(fixture).git)

    expect(outcome.status).toBe('skipped_dirty_worktree')
    expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('SECRET=mine\n')
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
    // Control: a plain fast-forward silently replaces the ignored file.
    fixture.git(['merge', '--ff-only', '--quiet', fixture.remoteOid])
    expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('from upstream\n')
  })

  it('moves main without running the post-merge hook of the checkout', async () => {
    const fixture = await createBehindRepo()
    const marker = join(fixture.repoPath, '..', 'hook-ran')
    const hookPath = join(fixture.repoPath, '.git', 'hooks', 'post-merge')
    await writeFile(hookPath, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`)
    await chmod(hookPath, 0o755)

    const outcome = await fastForward(fixture, realGit(fixture).git)

    expect(outcome).toMatchObject({ status: 'updated' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
    expect(await readFile(join(fixture.repoPath, 'version.txt'), 'utf8')).toBe('two\n')
    expect(existsSync(marker)).toBe(false)
    // Control: the hook is live, so only the override kept it from running.
    fixture.git(['reset', '--quiet', '--hard', fixture.localOid])
    fixture.git(['merge', '--ff-only', '--quiet', fixture.remoteOid])
    expect(existsSync(marker)).toBe(true)
  })

  // Why: each setting is live (the control shows a plain `merge --ff-only` obeying it), yet the owner
  // update must still land main exactly on the target as a fast-forward.
  it.each([
    ['merge.verifySignatures', 'true', 'refuses'],
    ['branch.main.mergeOptions', '--verify-signatures', 'refuses'],
    ['branch.main.mergeOptions', '-s ours', 'merge-commit'],
    ['pull.twohead', 'ours', 'merge-commit'],
    ['branch.main.mergeOptions', '--squash', 'stages-only']
  ] as const)(
    'fast-forwards main exactly to the target despite %s=%s',
    async (key, value, control) => {
      const fixture = await createBehindRepo()
      fixture.git(['config', key, value])

      const outcome = await fastForward(fixture, realGit(fixture).git)

      expect(outcome).toMatchObject({ status: 'updated' })
      expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
      expect(fixture.git(['rev-list', '--parents', '-1', 'main'])).toBe(
        `${fixture.remoteOid} ${fixture.localOid}`
      )
      expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('from upstream\n')
      expect(fixture.git(['status', '--porcelain'])).toBe('')

      fixture.git(['reset', '--quiet', '--hard', fixture.localOid])
      const plainMerge = () => fixture.git(['merge', '--ff-only', '--quiet', fixture.remoteOid])
      if (control === 'refuses') {
        expect(plainMerge).toThrow(/does not have a GPG signature/)
        return
      }
      plainMerge()
      if (control === 'merge-commit') {
        // A merge commit that keeps local's tree and drops upstream's changes.
        expect(fixture.git(['rev-list', '--parents', '-1', 'main'])).toMatch(
          new RegExp(` ${fixture.localOid} ${fixture.remoteOid}$`)
        )
        expect(existsSync(join(fixture.repoPath, 'added.txt'))).toBe(false)
      } else {
        expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
        expect(fixture.git(['status', '--porcelain'])).not.toBe('')
      }
    }
  )

  it('keeps a tracked edit made after the inspection instead of overwriting it', async () => {
    const fixture = await createBehindRepo()
    const edited = join(fixture.repoPath, 'version.txt')

    const outcome = await fastForward(
      fixture,
      realGit(fixture, () => writeFile(edited, 'my edit\n')).git
    )

    expect(outcome.status).not.toBe('updated')
    expect(outcome.status).toBe('skipped_dirty_worktree')
    expect(await readFile(edited, 'utf8')).toBe('my edit\n')
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
  })

  it('keeps a commit made on main after the inspection', async () => {
    const fixture = await createBehindRepo()
    let userCommit = ''
    const commitOnMain = async () => {
      await writeFile(join(fixture.repoPath, 'local.txt'), 'local work\n')
      fixture.git(['add', 'local.txt'])
      fixture.git(['commit', '--quiet', '-m', 'local work'])
      userCommit = fixture.git(['rev-parse', 'HEAD'])
    }

    const outcome = await fastForward(fixture, realGit(fixture, commitOnMain).git)

    expect(outcome.status).not.toBe('updated')
    expect(outcome.status).toBe('skipped_not_fast_forward')
    expect(fixture.git(['rev-parse', 'main'])).toBe(userCommit)
  })

  it('moves a branch no worktree has checked out and records why in its reflog', async () => {
    const fixture = await createBehindRepo()
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    const real = realGit(fixture)

    const outcome = await fastForward(fixture, real.git)

    expect(outcome).toEqual({ status: 'updated' })
    expect(real.merges()).toBe(0)
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
    expect(fixture.git(['reflog', 'show', '--format=%gs', '-1', 'main'])).toBe(
      'orca: fast-forward to refs/remotes/origin/main'
    )
    // The checked-out branch and its files are untouched.
    expect(fixture.git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/develop')
    expect(await readFile(join(fixture.repoPath, 'version.txt'), 'utf8')).toBe('one\n')
  })
})
