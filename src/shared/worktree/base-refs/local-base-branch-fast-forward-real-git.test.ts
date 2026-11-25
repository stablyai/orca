import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorktreeList } from '../../git/worktrees/git-worktree-porcelain-parser'
import {
  fastForwardCheckedOutLocalBaseBranch,
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

/** Real git; `afterInspection` runs once the drift count returns. */
function realGit(fixture: Fixture, afterInspection?: () => Promise<void> | void) {
  const run = (args: string[], cwd: string) =>
    new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('git', args, { cwd, env: fixture.env, encoding: 'utf8' }, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout })
      )
    })
  const listWorktrees = async (repoPath: string) =>
    parseWorktreeList((await run(['worktree', 'list', '--porcelain'], repoPath)).stdout)
  const git: LocalBaseBranchGit = {
    exec: async (args, cwd) => {
      const result = await run(args, cwd)
      if (args[0] === 'rev-list') {
        await afterInspection?.()
      }
      return result
    },
    readBranchUse: async (repoPath, fullRef) => ({
      reserved: false,
      ownerPath: (await listWorktrees(repoPath)).find((wt) => wt.branch === fullRef)?.path
    }),
    updateRefUnlessInUse: async (repoPath, fullRef, args) => {
      if ((await listWorktrees(repoPath)).some((wt) => wt.branch === fullRef)) {
        return false
      }
      await git.exec(args, repoPath)
      return true
    }
  }
  return { git }
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
  it('leaves a checked-out main, its files and its index alone', async () => {
    const fixture = await createBehindRepo()
    await writeFile(join(fixture.repoPath, 'added.txt'), 'my notes\n')

    const outcome = await fastForward(fixture, realGit(fixture).git)

    expect(outcome).toEqual({ status: 'nothing_to_do' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
    expect(await readFile(join(fixture.repoPath, 'version.txt'), 'utf8')).toBe('one\n')
    expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('my notes\n')
  })

  it('leaves main alone when it is checked out after the inspection', async () => {
    const fixture = await createBehindRepo()
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    const checkOutMain = () => {
      fixture.git(['checkout', '--quiet', 'main'])
    }

    const outcome = await fastForward(fixture, realGit(fixture, checkOutMain).git)

    expect(outcome).toEqual({ status: 'nothing_to_do' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
    expect(fixture.git(['status', '--porcelain'])).toBe('')
  })

  it('keeps a move of main made after the inspection', async () => {
    const fixture = await createBehindRepo()
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    let userCommit = ''
    const moveMain = () => {
      const tree = fixture.git(['rev-parse', `${fixture.localOid}^{tree}`])
      userCommit = fixture.git(['commit-tree', tree, '-p', fixture.localOid, '-m', 'local work'])
      fixture.git(['update-ref', 'refs/heads/main', userCommit])
    }

    const outcome = await fastForward(fixture, realGit(fixture, moveMain).git)

    expect(outcome).toEqual({ status: 'skipped_not_fast_forward' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(userCommit)
  })

  it('moves a branch no worktree has checked out', async () => {
    const fixture = await createBehindRepo()
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    const real = realGit(fixture)

    const outcome = await fastForward(fixture, real.git)

    expect(outcome).toEqual({ status: 'updated' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
    expect(fixture.git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/develop')
    expect(await readFile(join(fixture.repoPath, 'version.txt'), 'utf8')).toBe('one\n')
  })

  it('flags a local branch hidden below a shallow boundary, and moves it once history is complete', async () => {
    const fixture = await createBehindRepo()
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    const upstreamPath = join(fixture.repoPath, '..', 'upstream')
    fixture.git(['init', '--quiet', '--bare', upstreamPath])
    fixture.git(['push', '--quiet', upstreamPath, `${fixture.remoteOid}:refs/heads/main`])
    fixture.git(['remote', 'add', 'origin', pathToFileURL(upstreamPath).href])
    // Why file://: Git ignores --depth for plain-path remotes.
    fixture.git(['fetch', '--quiet', '--depth=1', 'origin', 'main'])
    const real = realGit(fixture)

    expect(await fastForward(fixture, real.git)).toEqual({
      status: 'skipped_not_fast_forward',
      shallowHistory: true
    })

    fixture.git(['fetch', '--quiet', '--unshallow', 'origin'])
    expect(await fastForward(fixture, real.git)).toMatchObject({ status: 'updated' })
    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
  })
})

describe('fastForwardCheckedOutLocalBaseBranch against real Git', () => {
  const refs = (fixture: Fixture) => ({
    repoPath: fixture.repoPath,
    fullRef: 'refs/heads/main',
    remoteTrackingRef: 'refs/remotes/origin/main'
  })

  it('fast-forwards a clean checked-out main and its files', async () => {
    const fixture = await createBehindRepo()

    await fastForwardCheckedOutLocalBaseBranch(realGit(fixture).git, refs(fixture))

    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.remoteOid)
    expect(await readFile(join(fixture.repoPath, 'added.txt'), 'utf8')).toBe('from upstream\n')
    expect(fixture.git(['status', '--porcelain'])).toBe('')
  })

  it('leaves a main that several checkouts share alone', async () => {
    const fixture = await createBehindRepo()
    const { git } = realGit(fixture)
    const shared: LocalBaseBranchGit = {
      ...git,
      readBranchUse: async (repoPath, fullRef) => ({
        ...(await git.readBranchUse(repoPath, fullRef)),
        sharedCheckout: true
      })
    }

    await fastForwardCheckedOutLocalBaseBranch(shared, refs(fixture))

    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
  })

  it('leaves a checked-out main with uncommitted edits alone', async () => {
    const fixture = await createBehindRepo()
    await writeFile(join(fixture.repoPath, 'version.txt'), 'mine\n')

    await fastForwardCheckedOutLocalBaseBranch(realGit(fixture).git, refs(fixture))

    expect(fixture.git(['rev-parse', 'main'])).toBe(fixture.localOid)
    expect(await readFile(join(fixture.repoPath, 'version.txt'), 'utf8')).toBe('mine\n')
  })
})
