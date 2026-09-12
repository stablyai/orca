import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deleteCurrentWorkspaceImmediately,
  resolveCurrentWorkspaceDeleteTarget
} from './current-workspace-delete'

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

const inertDocument = { activeElement: null } as Pick<Document, 'activeElement'>

function state(
  worktrees: Worktree[] = [],
  active: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'> = {
    activeWorktreeId: worktrees[0]?.id ?? null,
    activeWorkspaceExecutionHostId: worktrees[0]?.hostId ?? null
  }
): AppState {
  return {
    activeModal: 'none',
    ...active,
    deleteFolderWorkspace: vi.fn(),
    deleteStateByWorktreeId: {},
    setActiveWorktree: vi.fn(),
    worktreesByRepo: { repo: worktrees }
  } as unknown as AppState
}

describe('current workspace delete', () => {
  it('targets the active worktree, not whichever row the pointer last rested on', () => {
    const active = worktree({ id: 'repo::/active', path: '/active', hostId: 'local' })
    const other = worktree({ hostId: 'local', instanceId: 'instance-2' })

    expect(
      resolveCurrentWorkspaceDeleteTarget(
        state([other, active], {
          activeWorktreeId: active.id,
          activeWorkspaceExecutionHostId: 'local'
        }),
        inertDocument
      )
    ).toEqual({ kind: 'worktree', worktree: active })
  })

  it('resolves the active host when the same path is registered on two hosts', () => {
    const local = worktree({ hostId: 'local', instanceId: 'instance-local' })
    const remote = worktree({ hostId: 'ssh:build', instanceId: 'instance-remote' })

    expect(
      resolveCurrentWorkspaceDeleteTarget(
        state([local, remote], {
          activeWorktreeId: remote.id,
          activeWorkspaceExecutionHostId: 'ssh:build'
        }),
        inertDocument
      )
    ).toEqual({ kind: 'worktree', worktree: remote })
  })

  it('resolves the active folder workspace with its execution host', () => {
    expect(
      resolveCurrentWorkspaceDeleteTarget(
        state([], {
          activeWorktreeId: 'folder:folder-1',
          activeWorkspaceExecutionHostId: 'runtime:remote-1'
        }),
        inertDocument
      )
    ).toEqual({
      kind: 'folder',
      executionHostId: 'runtime:remote-1',
      folderWorkspaceId: 'folder-1',
      workspaceKey: 'folder:folder-1'
    })
  })

  it('rejects primary worktrees, unknown ids, and no active workspace', () => {
    const primary = worktree({ hostId: 'local', isMainWorktree: true })

    expect(resolveCurrentWorkspaceDeleteTarget(state([primary]), inertDocument)).toBeNull()
    expect(
      resolveCurrentWorkspaceDeleteTarget(
        state([primary], { activeWorktreeId: 'stale', activeWorkspaceExecutionHostId: 'local' }),
        inertDocument
      )
    ).toBeNull()
    expect(
      resolveCurrentWorkspaceDeleteTarget(
        state([primary], { activeWorktreeId: null, activeWorkspaceExecutionHostId: null }),
        inertDocument
      )
    ).toBeNull()
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

    expect(resolveCurrentWorkspaceDeleteTarget(current, inertDocument)).toBeNull()
  })

  it('rejects the shortcut while a modal is open', () => {
    const current = state([worktree({ hostId: 'local' })])
    current.activeModal = 'delete-worktree'

    expect(resolveCurrentWorkspaceDeleteTarget(current, inertDocument)).toBeNull()
  })

  it('rejects the shortcut while an editable control has focus', () => {
    class EditableElement {
      classList = { contains: () => false }
      isContentEditable = false
      closest = () => this
    }
    vi.stubGlobal('HTMLElement', EditableElement)
    const doc = { activeElement: new EditableElement() } as unknown as Pick<
      Document,
      'activeElement'
    >

    try {
      expect(
        resolveCurrentWorkspaceDeleteTarget(state([worktree({ hostId: 'local' })]), doc)
      ).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes the active worktree through the host-qualified safety flow', () => {
    const target = worktree({ hostId: 'ssh:build', instanceId: 'instance-2' })
    const deleteWorktree = vi.fn()
    const current = state([target])

    expect(
      deleteCurrentWorkspaceImmediately(
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
      expectedInstanceId: 'instance-2'
    })
  })

  it('removes the active folder workspace from Orca without deleting its directory', async () => {
    const current = state([], {
      activeWorktreeId: 'folder:folder-1',
      activeWorkspaceExecutionHostId: 'runtime:remote-1'
    })
    current.deleteFolderWorkspace = vi.fn().mockResolvedValue(true)

    expect(
      deleteCurrentWorkspaceImmediately(
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

    expect(deleteCurrentWorkspaceImmediately(current, target, dependencies)).toBe(true)
    expect(deleteCurrentWorkspaceImmediately(current, target, dependencies)).toBe(false)
    expect(current.deleteFolderWorkspace).toHaveBeenCalledOnce()

    finishDelete(false)
    await vi.waitFor(() =>
      expect(deleteCurrentWorkspaceImmediately(current, target, dependencies)).toBe(true)
    )
    finishDelete(false)
  })
})
