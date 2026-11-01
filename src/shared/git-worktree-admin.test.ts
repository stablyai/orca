import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGitCommonDirectory } from './git-common-directory'
import {
  annotateWorktreeLocksFromAdmin,
  findLinkedWorktreeGitDirectory,
  isBranchReservedByWorktreeOperation
} from './git-worktree-admin'
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
  it('finds one exact linked registration after its checkout disappears', async () => {
    await rm(linked, { recursive: true })
    await expect(findLinkedWorktreeGitDirectory(repo, linked)).resolves.toBe(admin)
    await expect(findLinkedWorktreeGitDirectory(repo, `${linked}-other`)).resolves.toBeNull()
    await expect(findLinkedWorktreeGitDirectory(repo, repo)).resolves.toBeNull()
    await writeFile(
      path.join(admin, 'gitdir'),
      `${path.relative(admin, path.join(linked, '.git'))}\n`
    )
    await expect(findLinkedWorktreeGitDirectory(repo, linked)).resolves.toBe(admin)
  })

  it('rejects duplicate registrations instead of choosing an owner marker', async () => {
    const duplicate = path.join(common, 'worktrees', 'duplicate')
    await mkdir(duplicate)
    await writeFile(path.join(duplicate, 'gitdir'), `${path.join(linked, '.git')}\n`)
    await expect(findLinkedWorktreeGitDirectory(repo, linked)).rejects.toThrow(
      'Cannot verify linked worktree administration'
    )
  })

  it('rejects a backlink to a file other than the checkout gitfile', async () => {
    await writeFile(path.join(admin, 'gitdir'), `${path.join(linked, 'other')}\n`)
    await expect(findLinkedWorktreeGitDirectory(repo, linked)).rejects.toThrow(
      'Cannot verify linked worktree administration'
    )
  })

  it.runIf(process.platform !== 'win32')(
    'rejects administrative directories redirected outside the common directory',
    async () => {
      const outside = path.join(root, 'outside-administration')
      const worktrees = path.join(common, 'worktrees')
      await rename(worktrees, outside)
      await symlink(outside, worktrees)
      await expect(findLinkedWorktreeGitDirectory(repo, linked)).rejects.toThrow(
        'Cannot verify linked worktree administration'
      )
    }
  )

  it.runIf(process.platform !== 'win32')('rejects symlinked backlink files', async () => {
    const outside = path.join(root, 'outside-backlink')
    await writeFile(outside, `${path.join(linked, '.git')}\n`)
    await rm(path.join(admin, 'gitdir'))
    await symlink(outside, path.join(admin, 'gitdir'))
    await expect(findLinkedWorktreeGitDirectory(repo, linked)).rejects.toThrow(
      'Cannot verify linked worktree administration'
    )
  })

  it.runIf(process.platform !== 'win32')(
    'rejects symlink administrative entries instead of overlooking duplicates',
    async () => {
      await symlink(admin, path.join(common, 'worktrees', 'duplicate-link'))
      await expect(findLinkedWorktreeGitDirectory(repo, linked)).rejects.toThrow(
        'Cannot verify linked worktree administration'
      )
    }
  )

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
      await expect(
        isBranchReservedByWorktreeOperation(repo, 'feature', detachedMain)
      ).resolves.toBe(true)
      await expect(isBranchReservedByWorktreeOperation(repo, 'other', detachedMain)).resolves.toBe(
        false
      )
    }
  )

  it('fails closed when a detached registration cannot be associated with admin metadata', async () => {
    await rm(path.join(admin, 'gitdir'))
    await expect(isBranchReservedByWorktreeOperation(repo, 'feature', rows())).rejects.toThrow(
      'Cannot verify worktree branch usage'
    )
  })

  it.each([40, 64])(
    'protects auxiliary rebase refs with %i-character OIDs on attached worktrees',
    async (length) => {
      await mkdir(path.join(admin, 'rebase-merge'))
      const before = 'a'.repeat(length)
      const after = '0'.repeat(length)
      await writeFile(
        path.join(admin, 'rebase-merge', 'update-refs'),
        `refs/heads/other\r\n${before}\r\n${after}\r\nrefs/heads/feature\r\n${before}\r\n${after}\r\n`
      )
      const attached = rows().map((row) => ({ ...row, branch: 'refs/heads/main' }))
      await expect(isBranchReservedByWorktreeOperation(repo, 'feature', attached)).resolves.toBe(
        true
      )
      await expect(isBranchReservedByWorktreeOperation(repo, 'unreserved', attached)).resolves.toBe(
        false
      )
    }
  )

  it('checks update-refs in the main worktree and compares only ref-name fields', async () => {
    await mkdir(path.join(common, 'rebase-merge'))
    await writeFile(
      path.join(common, 'rebase-merge', 'update-refs'),
      `refs/heads/feature\n${'a'.repeat(40)}\n${'0'.repeat(40)}\n`
    )
    await expect(isBranchReservedByWorktreeOperation(repo, 'feature', rows())).resolves.toBe(true)
    await expect(isBranchReservedByWorktreeOperation(repo, 'a'.repeat(40), rows())).resolves.toBe(
      false
    )
  })

  it.each([
    `refs/heads/feature\n${'a'.repeat(40)}\n`,
    `refs/heads/feature\n${'a'.repeat(40)}\n${'g'.repeat(40)}\n`,
    `refs/heads/feature\n${'a'.repeat(40)}\n${'0'.repeat(64)}\n`,
    `refs/heads/feature\n${'a'.repeat(40)}\n${'0'.repeat(40)}\ninvalid\n`
  ])('fails closed on malformed update-refs records: %s', async (contents) => {
    await mkdir(path.join(admin, 'rebase-merge'))
    await writeFile(path.join(admin, 'rebase-merge', 'update-refs'), contents)
    await expect(isBranchReservedByWorktreeOperation(repo, 'feature', rows())).rejects.toThrow(
      'Cannot verify rebase update-refs branch usage'
    )
  })

  it('fails closed when update-refs cannot be read', async () => {
    await mkdir(path.join(admin, 'rebase-merge', 'update-refs'), { recursive: true })
    await expect(isBranchReservedByWorktreeOperation(repo, 'feature', rows())).rejects.toThrow()
  })

  it('propagates cancellation during administrative reads', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(annotateWorktreeLocksFromAdmin(repo, rows(), { signal })).rejects.toThrow(
      'cancelled'
    )
    await expect(
      isBranchReservedByWorktreeOperation(repo, 'feature', rows(), { signal })
    ).rejects.toThrow('cancelled')
    await expect(findLinkedWorktreeGitDirectory(repo, linked, { signal })).rejects.toThrow(
      'cancelled'
    )
  })
})
