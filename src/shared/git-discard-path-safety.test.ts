import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
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
    await writeFile(keepFile, 'keep')

    await expect(removeSafeUntrackedDiscardTarget(worktreePath, '')).rejects.toThrow(
      'resolves outside the worktree'
    )
    await expect(removeSafeUntrackedDiscardTarget(worktreePath, '.')).rejects.toThrow(
      'resolves outside the worktree'
    )
    await expect(removeSafeUntrackedDiscardTarget(worktreePath, 'child/..')).rejects.toThrow(
      'resolves outside the worktree'
    )

    await expect(access(keepFile)).resolves.toBeUndefined()
  })

  it('allows missing child paths whose nearest existing parent is the worktree', async () => {
    const worktreePath = await createWorktree()
    await mkdir(path.join(worktreePath, 'existing'))

    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'existing/missing.txt')
    ).resolves.toBeUndefined()
    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'new-dir/missing.txt')
    ).resolves.toBeUndefined()
    await expect(
      removeSafeUntrackedDiscardTarget(worktreePath, 'missing.txt')
    ).resolves.toBeUndefined()
    await expect(access(worktreePath)).resolves.toBeUndefined()
  })
})
