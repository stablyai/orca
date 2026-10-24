import { createTestStore } from '@/store/slices/worktrees-slice-test-harness'
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeFolderWorkspace } from '../worktree-jump-palette-test-fixtures'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  deleteHoveredWorkspaceImmediately,
  getHoveredWorkspaceIdentity,
  resolveHoveredWorkspaceDeleteTarget,
  type HoveredWorkspaceDeleteTarget
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

function state(
  worktrees: Worktree[] = [],
  folderWorkspaces: AppState['folderWorkspaces'] = []
): AppState {
  return {
    ...createTestStore().getState(),
    projectGroups: [],
    editorBufferIdOf: {},
    editorBufferViews: {},
    activeModal: 'none',
    activeWorkspaceExecutionHostId: worktrees[0]?.hostId ?? null,
    activeWorktreeId: worktrees[0]?.id ?? null,
    deleteFolderWorkspace: vi.fn(),
    deleteStateByWorktreeId: {},
    setActiveWorktree: vi.fn(),
    worktreesByRepo: { repo: worktrees },
    folderWorkspaces
  }
}

describe('hovered workspace delete', () => {
  it('uses the deepest hovered worktree row', () => {
    expect(
      getHoveredWorkspaceIdentity(
        hoveredDocument(
          { workspaceId: 'parent', hostIdentity: 'local|parent' },
          { workspaceId: 'child', hostIdentity: 'local|child' }
        )
      )
    ).toEqual({ workspaceId: 'child', hostIdentity: 'local|child' })
  })

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

  it('retains the hovered host when resolving a folder workspace', () => {
    const folder = makeFolderWorkspace({ executionHostId: 'runtime:remote-1' })
    expect(
      resolveHoveredWorkspaceDeleteTarget(
        state([], [folder]),
        hoveredDocument({
          workspaceId: 'folder:folder-1',
          hostIdentity: 'runtime:remote-1|folder:folder-1'
        })
      )
    ).toEqual({
      kind: 'folder',
      executionHostId: 'runtime:remote-1',
      folderWorkspaceId: 'folder-1',
      workspaceKey: 'folder:folder-1',
      worktree: folderWorkspaceToWorktree(folder)
    })
  })

  it('rejects primary worktrees, stale rows, and missing hover', () => {
    const primary = worktree({ hostId: 'local', isMainWorktree: true })
    const current = state([primary])

    expect(
      resolveHoveredWorkspaceDeleteTarget(
        current,
        hoveredDocument({ workspaceId: primary.id, hostIdentity: 'local|repo::/feature' })
      )
    ).toBeNull()
    expect(
      resolveHoveredWorkspaceDeleteTarget(
        current,
        hoveredDocument({ workspaceId: 'stale', hostIdentity: 'local|stale' })
      )
    ).toBeNull()
    expect(resolveHoveredWorkspaceDeleteTarget(current, hoveredDocument())).toBeNull()
  })

  it('rejects worktrees that are already deleting', () => {
    const target = worktree({ hostId: 'ssh:build' })
    const current = state([target])
    current.deleteStateByWorktreeId = {
      'ssh:build|repo::/feature': {
        isDeleting: true,
        error: null,
        canForceDelete: false,
        forceDeleteReason: null
      }
    }

    expect(
      resolveHoveredWorkspaceDeleteTarget(
        current,
        hoveredDocument({ workspaceId: target.id, hostIdentity: 'ssh:build|repo::/feature' })
      )
    ).toBeNull()
  })

  it('rejects hovered rows while an editable control has focus', () => {
    class EditableElement {
      classList = { contains: () => false }
      isContentEditable = false
      closest = () => this
    }
    vi.stubGlobal('HTMLElement', EditableElement)
    const target = worktree({ hostId: 'local' })
    const doc = hoveredDocument({
      workspaceId: target.id,
      hostIdentity: 'local|repo::/feature'
    }) as Pick<Document, 'activeElement' | 'querySelectorAll'>
    Object.defineProperty(doc, 'activeElement', { value: new EditableElement() })

    try {
      expect(resolveHoveredWorkspaceDeleteTarget(state([target]), doc)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes the hovered worktree through the host-qualified safety flow', () => {
    const target = worktree({ hostId: 'ssh:build', instanceId: 'instance-2' })
    const deleteWorktree = vi.fn()
    const current = state([target])

    expect(
      deleteHoveredWorkspaceImmediately(
        current,
        { kind: 'worktree', worktree: target },
        {
          deleteWorktree,
          getCurrentState: () => current
        }
      )
    ).toBe(true)
    expect(deleteWorktree).toHaveBeenCalledWith(target.id, {
      expectedHostId: 'ssh:build',
      expectedInstanceId: 'instance-2',
      expectedIdentity: {
        id: target.id,
        hostId: 'ssh:build',
        instanceId: 'instance-2',
        storeKey: ''
      }
    })
  })

  it('removes a hovered folder workspace from Orca without deleting its directory', async () => {
    const folder = makeFolderWorkspace({ executionHostId: 'runtime:remote-1' })
    const current = state([], [folder])
    current.activeWorktreeId = 'folder:folder-1'
    current.activeWorkspaceExecutionHostId = 'runtime:remote-1'
    current.deleteFolderWorkspace = vi.fn().mockResolvedValue(true)

    const target: HoveredWorkspaceDeleteTarget = {
      kind: 'folder',
      executionHostId: 'runtime:remote-1',
      folderWorkspaceId: 'folder-1',
      workspaceKey: 'folder:folder-1',
      worktree: folderWorkspaceToWorktree(folder)
    }
    const dependencies = { deleteWorktree: vi.fn(), getCurrentState: () => current }
    getCurrentState.mockReturnValue({
      ...current,
      folderWorkspaces: [{ ...folder, executionHostId: 'runtime:remote-2' }]
    })
    expect(deleteHoveredWorkspaceImmediately(current, target, dependencies)).toBe(false)
    expect(current.deleteFolderWorkspace).not.toHaveBeenCalled()
    getCurrentState.mockReturnValue(current)
    expect(deleteHoveredWorkspaceImmediately(current, target, dependencies)).toBe(true)
    await vi.waitFor(() => expect(current.setActiveWorktree).toHaveBeenCalledWith(null))
    expect(current.deleteFolderWorkspace).toHaveBeenCalledWith('folder-1', {
      executionHostId: 'runtime:remote-1'
    })
  })

  it('rejects a duplicate folder delete while the first request is pending', async () => {
    let finishDelete!: (deleted: boolean) => void
    const folder = makeFolderWorkspace({ id: 'folder-2', executionHostId: 'runtime:remote-2' })
    const current = state([], [folder])
    getCurrentState.mockReturnValue(current)
    current.deleteFolderWorkspace = vi.fn(
      () => new Promise<boolean>((resolve) => (finishDelete = resolve))
    )
    const target: HoveredWorkspaceDeleteTarget = {
      kind: 'folder',
      executionHostId: 'runtime:remote-2',
      folderWorkspaceId: 'folder-2',
      workspaceKey: 'folder:folder-2',
      worktree: folderWorkspaceToWorktree(folder)
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

const { rejectAppStoreAccess, getCurrentState } = vi.hoisted(() => ({
  getCurrentState: vi.fn<() => ReturnType<typeof state>>(),
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: getCurrentState,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
  getCurrentState.mockReset()
})
