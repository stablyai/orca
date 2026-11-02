import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deleteHoveredWorkspaceImmediately,
  resolveHoveredWorkspaceDeleteTarget
} from './hovered-workspace-delete'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    path: '/feature',
    branch: 'feature',
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

function hoveredDocument(...rows: { workspaceId: string; hostIdentity: string }[]) {
  return {
    activeElement: null,
    querySelectorAll: () => ({
      length: rows.length,
      item: (index: number) => {
        const row = rows[index]
        return row
          ? ({
              dataset: {
                worktreeId: row.workspaceId,
                worktreeHostIdentity: row.hostIdentity
              }
            } as unknown as HTMLElement)
          : null
      }
    })
  } as unknown as Pick<Document, 'activeElement' | 'querySelectorAll'>
}

function state(worktrees: Worktree[] = []): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hover helpers read only these fields.
  return {
    activeModal: 'none',
    activeWorkspaceExecutionHostId: worktrees[0]?.hostId ?? null,
    activeWorktreeId: worktrees[0]?.id ?? null,
    deleteFolderWorkspace: vi.fn(),
    deleteStateByWorktreeId: {},
    folderWorkspaces: [],
    setActiveWorktree: vi.fn(),
    worktreesByRepo: { repo: worktrees }
  } as unknown as AppState
}

describe('hovered workspace delete', () => {
  it('resolves the exact hovered host instead of the active workspace', () => {
    const active = worktree({ id: 'repo::/active', path: '/active', hostId: 'local' })
    const hovered = worktree({ hostId: 'ssh:build', instanceId: 'instance-2' })

    expect(
      resolveHoveredWorkspaceDeleteTarget(
        state([active, hovered]),
        hoveredDocument({ workspaceId: hovered.id, hostIdentity: 'ssh:build|repo::/feature' })
      )
    ).toEqual({ kind: 'worktree', worktree: hovered })
  })

  it('removes a hovered folder workspace from Orca without deleting its directory', async () => {
    const current = state()
    current.activeWorktreeId = 'folder:folder-1'
    current.activeWorkspaceExecutionHostId = 'runtime:remote-1'
    current.deleteFolderWorkspace = vi.fn().mockResolvedValue(true)

    expect(
      deleteHoveredWorkspaceImmediately(
        current,
        {
          kind: 'folder',
          executionHostId: 'runtime:remote-1',
          folderWorkspaceId: 'folder-1',
          workspaceKey: 'folder:folder-1'
        },
        { deleteWorktree: vi.fn(), getCurrentState: () => current }
      )
    ).toBe(true)
    await vi.waitFor(() => expect(current.setActiveWorktree).toHaveBeenCalledWith(null))
    expect(current.deleteFolderWorkspace).toHaveBeenCalledWith('folder-1', {
      executionHostId: 'runtime:remote-1'
    })
  })

  it('rejects a duplicate folder delete while the first request is pending', async () => {
    let finishDelete!: (deleted: boolean) => void
    const current = state()
    current.deleteFolderWorkspace = vi.fn(
      () => new Promise<boolean>((resolve) => (finishDelete = resolve))
    )
    const target = {
      kind: 'folder' as const,
      executionHostId: 'runtime:remote-2' as const,
      folderWorkspaceId: 'folder-2',
      workspaceKey: 'folder:folder-2'
    }
    const dependencies = { deleteWorktree: vi.fn(), getCurrentState: () => current }

    expect(deleteHoveredWorkspaceImmediately(current, target, dependencies)).toBe(true)
    expect(deleteHoveredWorkspaceImmediately(current, target, dependencies)).toBe(false)
    expect(current.deleteFolderWorkspace).toHaveBeenCalledOnce()

    finishDelete(false)
    await vi.waitFor(() =>
      expect(deleteHoveredWorkspaceImmediately(current, target, dependencies)).toBe(true)
    )
    finishDelete(false)
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
