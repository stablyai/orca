import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGitCommonDirectory } from './git-common-directory'
import { annotateWorktreeLocksFromAdmin, isBranchInDetachedWorktree } from './git-worktree-admin'
import type { GitWorktreeInfo } from './worktree/types'
import { isWorktreeCreatePreparation } from './worktree/create-preparation'

let root = ''
let repo = ''
let common = ''
let linked = ''
let admin = ''
const preparationReason = 'orca-create-preparation:v1:12345:lease'

function rows(): GitWorktreeInfo[] {
  return [
    { path: repo, branch: 'refs/heads/main', head: 'abc', isBare: false, isMainWorktree: true },
    { path: linked, branch: '', head: 'abc', isBare: false, isMainWorktree: false }
  ]
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-admin-safety-'))
  repo = path.join(root, 'repo')
  common = path.join(repo, '.git')
  linked = path.join(root, '.orca-preparing', 'checkout')
  admin = path.join(common, 'worktrees', 'checkout')
  await mkdir(admin, { recursive: true })
  await mkdir(linked, { recursive: true })
  await writeFile(path.join(common, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(path.join(admin, 'gitdir'), `${path.join(linked, '.git')}\n`)
  await writeFile(path.join(admin, 'commondir'), '../..\n')
  await writeFile(path.join(linked, '.git'), `gitdir: ${admin}\r\n`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('owning-host worktree administrative reads', () => {
  it('resolves normal, linked, separate-git-dir and bare layouts without subprocesses', async () => {
    await expect(resolveGitCommonDirectory(repo)).resolves.toBe(common)
    await expect(resolveGitCommonDirectory(linked)).resolves.toBe(common)
    await expect(resolveGitCommonDirectory(common)).resolves.toBe(common)
    const separate = path.join(root, 'separate')
    await mkdir(separate)
    await writeFile(path.join(separate, '.git'), 'gitdir: ../repo/.git\r\n')
    await expect(resolveGitCommonDirectory(separate)).resolves.toBe(common)
  })

  it('recovers exact preparation reasons even when the checkout directory is missing', async () => {
    await writeFile(path.join(admin, 'locked'), `${preparationReason}\n`)
    await rm(linked, { recursive: true })
    const annotated = await annotateWorktreeLocksFromAdmin(repo, rows())
    expect(annotated[1]).toMatchObject({ locked: true, lockReason: preparationReason })
    expect(isWorktreeCreatePreparation(annotated[1])).toBe(true)
  })

  it('keeps empty and foreign locks without claiming preparations by path shape', async () => {
    await writeFile(path.join(admin, 'locked'), '')
    const empty = await annotateWorktreeLocksFromAdmin(repo, rows())
    expect(empty[1].locked).toBe(true)
    expect(isWorktreeCreatePreparation(empty[1])).toBe(false)
    await writeFile(path.join(admin, 'locked'), 'user session\n')
    const foreign = await annotateWorktreeLocksFromAdmin(repo, rows())
    expect(foreign[1]).toMatchObject({ locked: true, lockReason: 'user session' })
    expect(isWorktreeCreatePreparation(foreign[1])).toBe(false)
  })

  it('does not treat an unreadable marker as an unlocked authoritative registration', async () => {
    await mkdir(path.join(admin, 'locked'))
    await expect(annotateWorktreeLocksFromAdmin(repo, rows())).rejects.toThrow()
  })

  it('does not cache a replaced lock reason or another repository’s metadata', async () => {
    await writeFile(path.join(admin, 'locked'), `${preparationReason}\n`)
    expect((await annotateWorktreeLocksFromAdmin(repo, rows()))[1].lockReason).toBe(
      preparationReason
    )
    await writeFile(path.join(admin, 'locked'), 'replacement\n')
    expect((await annotateWorktreeLocksFromAdmin(repo, rows()))[1].lockReason).toBe('replacement')
    const other = path.join(root, 'other')
    await mkdir(path.join(other, '.git'), { recursive: true })
    await writeFile(path.join(other, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const otherRows = rows().map((row) => (row.isMainWorktree ? { ...row, path: other } : row))
    expect((await annotateWorktreeLocksFromAdmin(other, otherRows))[1].locked).toBeUndefined()
  })

  it.each(['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START'])(
    'checks detached main worktrees as well as linked ones: %s',
    async (marker) => {
      const file = path.join(common, ...marker.split('/'))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, 'refs/heads/feature\n')
      const detachedMain = rows().map((row) => (row.isMainWorktree ? { ...row, branch: '' } : row))
      await expect(isBranchInDetachedWorktree(repo, 'feature', detachedMain)).resolves.toBe(true)
      await expect(isBranchInDetachedWorktree(repo, 'other', detachedMain)).resolves.toBe(false)
    }
  )

  it('fails closed when a detached registration cannot be associated with admin metadata', async () => {
    await rm(path.join(admin, 'gitdir'))
    await expect(isBranchInDetachedWorktree(repo, 'feature', rows())).rejects.toThrow(
      'Cannot verify detached worktree branch usage'
    )
  })

  it('propagates cancellation during administrative reads', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(annotateWorktreeLocksFromAdmin(repo, rows(), { signal })).rejects.toThrow(
      'cancelled'
    )
    await expect(isBranchInDetachedWorktree(repo, 'feature', rows(), { signal })).rejects.toThrow(
      'cancelled'
    )
  })
})
