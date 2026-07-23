import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readRebaseStateFromGitDir,
  readWorktreeRebaseState,
  reprobeDetachedHeadRebaseState
} from './git-rebase-worktree-state'

describe('readRebaseStateFromGitDir', () => {
  const tmpDirs: string[] = []

  function makeGitDir(): string {
    const gitDir = mkdtempSync(path.join(tmpdir(), 'orca-rebase-state-'))
    tmpDirs.push(gitDir)
    return gitDir
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('recovers the branch from rebase-merge/head-name', async () => {
    const gitDir = makeGitDir()
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/x\n')

    expect(await readRebaseStateFromGitDir(gitDir)).toEqual({
      rebasing: true,
      rebaseBranch: 'feature/x'
    })
  })

  it('recovers the branch from rebase-apply gated on the `rebasing` sentinel', async () => {
    const gitDir = makeGitDir()
    await fs.mkdir(path.join(gitDir, 'rebase-apply'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-apply', 'rebasing'), '')
    await fs.writeFile(path.join(gitDir, 'rebase-apply', 'head-name'), 'refs/heads/topic\n')

    expect(await readRebaseStateFromGitDir(gitDir)).toEqual({
      rebasing: true,
      rebaseBranch: 'topic'
    })
  })

  it('rejects a git am (rebase-apply without the rebasing sentinel)', async () => {
    const gitDir = makeGitDir()
    await fs.mkdir(path.join(gitDir, 'rebase-apply'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-apply', 'applying'), '')

    expect(await readRebaseStateFromGitDir(gitDir)).toEqual({
      rebasing: false,
      rebaseBranch: null
    })
  })

  it('reports rebasing with no branch when head-name is absent but the rebase dir remains', async () => {
    const gitDir = makeGitDir()
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })

    expect(await readRebaseStateFromGitDir(gitDir)).toEqual({
      rebasing: true,
      rebaseBranch: null
    })
  })

  it('reports not rebasing when there is no rebase directory', async () => {
    const gitDir = makeGitDir()
    expect(await readRebaseStateFromGitDir(gitDir)).toEqual({
      rebasing: false,
      rebaseBranch: null
    })
  })
})

describe('readWorktreeRebaseState', () => {
  const tmpDirs: string[] = []

  function makeWorktree(): { worktreePath: string; gitDir: string } {
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'orca-rebase-worktree-'))
    tmpDirs.push(worktreePath)
    // Primary checkout: `.git` is a real directory that also holds rebase state.
    return { worktreePath, gitDir: path.join(worktreePath, '.git') }
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('recovers the branch through a `.git` directory', async () => {
    const { worktreePath, gitDir } = makeWorktree()
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/x\n')

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: true,
      rebaseBranch: 'feature/x'
    })
  })

  it('resolves a linked worktree `.git` pointer file and recovers the branch', async () => {
    const { worktreePath } = makeWorktree()
    const realGitDir = mkdtempSync(path.join(tmpdir(), 'orca-rebase-worktree-gitdir-'))
    tmpDirs.push(realGitDir)
    await fs.rm(path.join(worktreePath, '.git'), { recursive: true, force: true })
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${realGitDir}\n`)
    await fs.mkdir(path.join(realGitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(
      path.join(realGitDir, 'rebase-merge', 'head-name'),
      'refs/heads/linked/topic\n'
    )

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: true,
      rebaseBranch: 'linked/topic'
    })
  })

  it('reports rebasing with no branch for a rebase started from a detached HEAD', async () => {
    const { worktreePath, gitDir } = makeWorktree()
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-merge', 'head-name'), 'detached HEAD\n')

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: true,
      rebaseBranch: null
    })
  })

  it('reports not rebasing for a clean worktree', async () => {
    const { worktreePath } = makeWorktree()
    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: false,
      rebaseBranch: null
    })
  })
})

describe('reprobeDetachedHeadRebaseState', () => {
  it('keeps an early "rebasing" result without re-probing (rebase --abort torn read)', async () => {
    const reprobe = vi.fn()

    await expect(
      reprobeDetachedHeadRebaseState({ rebasing: true, rebaseBranch: 'feature/x' }, reprobe)
    ).resolves.toEqual({ rebasing: true, rebaseBranch: 'feature/x' })
    expect(reprobe).not.toHaveBeenCalled()
  })

  it('adopts the re-probe result when the early probe predates a rebase start', async () => {
    await expect(
      reprobeDetachedHeadRebaseState({ rebasing: false, rebaseBranch: null }, async () => ({
        rebasing: true,
        rebaseBranch: 'feature/x'
      }))
    ).resolves.toEqual({ rebasing: true, rebaseBranch: 'feature/x' })
  })

  it('falls back to the early state when the re-probe fails', async () => {
    await expect(
      reprobeDetachedHeadRebaseState({ rebasing: false, rebaseBranch: null }, async () => {
        throw new Error('EACCES')
      })
    ).resolves.toEqual({ rebasing: false, rebaseBranch: null })
  })
})
