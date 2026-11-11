import { afterEach, describe, expect, it } from 'vitest'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  getCloudOpenCover,
  holdCloudOpenCover,
  releaseCloudOpenCover,
  resetCloudOpenCovers,
  workspaceHasAttachedPty
} from './cloud-open-cover-store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only keeps the entry.
const entry = { creationId: 'c1' } as PendingWorktreeCreation

afterEach(resetCloudOpenCovers)

describe('cloud open cover', () => {
  it('holds the start screen for one workspace until released', () => {
    holdCloudOpenCover('w1', entry, 1_000)
    expect(getCloudOpenCover('w1')).toMatchObject({ worktreeId: 'w1', heldAt: 1_000 })
    expect(getCloudOpenCover('w2')).toBeNull()
    releaseCloudOpenCover('w1')
    expect(getCloudOpenCover('w1')).toBeNull()
  })

  it('counts the workspace as open only once one of its terminals has a PTY', () => {
    const noPtys: string[] = []
    const state = {
      tabsByWorktree: { w1: [{ id: 't1' }, { id: 't2' }] },
      ptyIdsByTabId: { t1: noPtys }
    }
    expect(workspaceHasAttachedPty(state, 'w1')).toBe(false)
    expect(
      workspaceHasAttachedPty({ ...state, ptyIdsByTabId: { t1: [], t2: ['pty-1'] } }, 'w1')
    ).toBe(true)
    expect(workspaceHasAttachedPty(state, 'missing')).toBe(false)
  })
})
