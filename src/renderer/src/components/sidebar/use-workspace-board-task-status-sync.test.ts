import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { linearSettingsForBoardWorktree } from './use-workspace-board-task-status-sync'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const WORKTREE_ID = 'repo::/w'
type OwnerHost = 'local' | 'runtime:env-b'

function ownedBy(...hostIds: OwnerHost[]) {
  return {
    folderWorkspaces: [],
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) =>
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo',
          hostId,
          ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-b' })
        })
      )
    }
  }
}

describe('linearSettingsForBoardWorktree', () => {
  it("uses the runtime owner's Linear settings", () => {
    expect(linearSettingsForBoardWorktree(ownedBy('runtime:env-b'), WORKTREE_ID)).toEqual({
      kind: 'environment',
      environmentId: 'env-b'
    })
  })

  it("skips a local twin of a server instead of borrowing this computer's Linear", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(linearSettingsForBoardWorktree(ownedBy('local', 'runtime:env-b'), WORKTREE_ID)).toBe(
      null
    )
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })

  it("uses a dragged twin card's own host, not this computer's Linear", () => {
    expect(
      linearSettingsForBoardWorktree(
        ownedBy('local', 'runtime:env-b'),
        WORKTREE_ID,
        'runtime:env-b'
      )
    ).toEqual({ kind: 'environment', environmentId: 'env-b' })
  })

  it('uses the captured host for a workspace on one host', () => {
    const state = ownedBy('runtime:env-b')
    expect(linearSettingsForBoardWorktree(state, WORKTREE_ID, 'runtime:env-b')).toEqual(
      linearSettingsForBoardWorktree(state, WORKTREE_ID)
    )
  })

  it.each<OwnerHost>(['local', 'runtime:env-b'])(
    'refuses a removed %s copy when only its twin remains',
    (hostId) => {
      const survivor = hostId === 'local' ? 'runtime:env-b' : 'local'
      expect(linearSettingsForBoardWorktree(ownedBy(survivor), WORKTREE_ID, hostId)).toBeNull()
    }
  )

  it('refuses a captured copy when all copies are gone', () => {
    expect(linearSettingsForBoardWorktree(ownedBy(), WORKTREE_ID, 'runtime:env-b')).toBeNull()
  })

  it('keeps folder workspace sync on the captured host', () => {
    const folder = makeFolderWorkspace({ executionHostId: 'runtime:env-b' })
    const state = { ...ownedBy(), folderWorkspaces: [folder] }
    const id = folderWorkspaceKey(folder.id)
    expect(linearSettingsForBoardWorktree(state, id, 'runtime:env-b')).toEqual({
      kind: 'environment',
      environmentId: 'env-b'
    })
    expect(linearSettingsForBoardWorktree(state, id, 'local')).toBeNull()
  })

  it('indexes an unchanged catalog once across a bulk sync', () => {
    let idReads = 0
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...makeWorktree({ id: `repo::/w-${index}`, repoId: 'repo', hostId: 'runtime:env-b' }),
      get id() {
        idReads += 1
        return `repo::/w-${index}`
      }
    }))
    const state = { ...ownedBy('runtime:env-b'), worktreesByRepo: { repo: rows } }

    for (let index = 0; index < rows.length; index += 1) {
      expect(linearSettingsForBoardWorktree(state, `repo::/w-${index}`, 'runtime:env-b')).toEqual({
        kind: 'environment',
        environmentId: 'env-b'
      })
    }

    expect(idReads).toBeLessThanOrEqual(rows.length * 2)
  })
})
