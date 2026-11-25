import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { removeSafeUntrackedDiscardTarget } from './git-discard-path-safety'

const tempRoots: string[] = []

async function createWorktree(): Promise<string> {
  const worktreePath = await mkdtemp(path.join(tmpdir(), 'orca-discard-safety-'))
  tempRoots.push(worktreePath)
  return worktreePath
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('removeSafeUntrackedDiscardTarget', () => {
  it('rejects empty and root targets before removing anything', async () => {
    const worktreePath = await createWorktree()
    const keepFile = path.join(worktreePath, 'keep.txt')
    const removePath = vi.fn(async () => undefined)
    await writeFile(keepFile, 'keep')

    await expect(removeSafeUntrackedDiscardTarget(worktreePath, '', removePath)).rejects.toThrow(
      'resolves outside the worktree'
    )
    await expect(removeSafeUntrackedDiscardTarget(worktreePath, '.', removePath)).rejects.toThrow(
      'resolves outside the worktree'
    )
    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'child/..', removePath)
    ).rejects.toThrow('resolves outside the worktree')

    await expect(access(keepFile)).resolves.toBeUndefined()
    expect(removePath).not.toHaveBeenCalled()
  })

  it('allows missing child paths whose nearest existing parent is the worktree', async () => {
    const worktreePath = await createWorktree()
    const removePath = vi.fn(async () => undefined)
    await mkdir(path.join(worktreePath, 'existing'))

    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'existing/missing.txt', removePath)
    ).resolves.toBeUndefined()
    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'new-dir/missing.txt', removePath)
    ).resolves.toBeUndefined()
    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'missing.txt', removePath)
    ).resolves.toBeUndefined()
    await expect(access(worktreePath)).resolves.toBeUndefined()
    expect(removePath).toHaveBeenNthCalledWith(1, 'existing/missing.txt')
    expect(removePath).toHaveBeenNthCalledWith(2, 'new-dir/missing.txt')
    expect(removePath).toHaveBeenNthCalledWith(3, 'missing.txt')
  })
})
