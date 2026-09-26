import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deleteHoveredWorkspaceImmediately,
  getActiveWorkspaceIdentity,
  getHoveredWorkspaceIdentity,
  resolveWorkspaceDeleteTarget
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
  return {
    activeModal: 'none',
    activeWorkspaceExecutionHostId: worktrees[0]?.hostId ?? null,
    activeWorktreeId: worktrees[0]?.id ?? null,
    deleteFolderWorkspace: vi.fn(),
    deleteStateByWorktreeId: {},
    setActiveWorktree: vi.fn(),
    worktreesByRepo: { repo: worktrees }
  } as unknown as AppState
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
      resolveWorkspaceDeleteTarget(
        state([active, hovered]),
        hoveredDocument({ workspaceId: hovered.id, hostIdentity: 'ssh:build|repo::/feature' })
      )
    ).toEqual({ kind: 'worktree', worktree: hovered })
  })

  it('retains the hovered host when resolving a folder workspace', () => {
    expect(
      resolveWorkspaceDeleteTarget(
        state(),
        hoveredDocument({
          workspaceId: 'folder:folder-1',
          hostIdentity: 'runtime:remote-1|folder:folder-1'
        })
      )
    ).toEqual({
      kind: 'folder',
      executionHostId: 'runtime:remote-1',
      folderWorkspaceId: 'folder-1',
      workspaceKey: 'folder:folder-1'
    })
  })

  it('falls back to the active workspace when the pointer is nowhere near a card', () => {
    // The shortcut is usable from the terminal, where hover is never true.
    const active = worktree({ id: 'repo::/active', path: '/active', hostId: 'local' })

    expect(getActiveWorkspaceIdentity(state([active]))).toEqual({
      workspaceId: 'repo::/active',
      hostIdentity: 'local|repo::/active'
    })
    expect(resolveWorkspaceDeleteTarget(state([active]), hoveredDocument())).toEqual({
      kind: 'worktree',
      worktree: active
    })
  })

  // Why: activation resolves the host (undefined -> 'local'), but a
  // pre-host-qualification row still carries no hostId, so the composed
  // 'local|<id>' identity never matched its '|<id>' one and delete no-opped.
  it('falls back to a legacy workspace whose row predates host qualification', () => {
    const legacy = worktree({ id: 'repo::/legacy', path: '/legacy' })
    const legacyState = state([legacy])
    legacyState.activeWorkspaceExecutionHostId = 'local'

    expect(getActiveWorkspaceIdentity(legacyState)).toEqual({
      workspaceId: 'repo::/legacy',
      hostIdentity: 'local|repo::/legacy'
    })
    expect(resolveWorkspaceDeleteTarget(legacyState, hoveredDocument())).toEqual({
      kind: 'worktree',
      worktree: legacy
    })
  })

  it("never lets the legacy fallback reach another host's row", () => {
    const remote = worktree({ id: 'repo::/shared', path: '/shared', hostId: 'ssh:build' })
    const remoteState = state([remote])
    remoteState.activeWorktreeId = 'repo::/shared'
    remoteState.activeWorkspaceExecutionHostId = 'local'

    expect(resolveWorkspaceDeleteTarget(remoteState, hoveredDocument())).toBeNull()
  })

  it('applies the same guards to the active workspace as to a hovered one', () => {
    const primary = worktree({ hostId: 'local', isMainWorktree: true })
    expect(resolveWorkspaceDeleteTarget(state([primary]), hoveredDocument())).toBeNull()

    const deleting = worktree({ hostId: 'local' })
    const current = state([deleting])
    current.deleteStateByWorktreeId = {
      'local|repo::/feature': {
        isDeleting: true,
        error: null,
        canForceDelete: false,
        forceDeleteReason: null
      }
    }
    expect(resolveWorkspaceDeleteTarget(current, hoveredDocument())).toBeNull()
  })

  it('has no active fallback when no workspace is active', () => {
    const current = state()
    expect(getActiveWorkspaceIdentity(current)).toBeNull()
    expect(resolveWorkspaceDeleteTarget(current, hoveredDocument())).toBeNull()
  })

  it('rejects primary worktrees, stale rows, and missing hover', () => {
    const primary = worktree({ hostId: 'local', isMainWorktree: true })
    const current = state([primary])

    expect(
      resolveWorkspaceDeleteTarget(
        current,
        hoveredDocument({ workspaceId: primary.id, hostIdentity: 'local|repo::/feature' })
      )
    ).toBeNull()
    expect(
      resolveWorkspaceDeleteTarget(
        current,
        hoveredDocument({ workspaceId: 'stale', hostIdentity: 'local|stale' })
      )
    ).toBeNull()
    expect(resolveWorkspaceDeleteTarget(current, hoveredDocument())).toBeNull()
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
      resolveWorkspaceDeleteTarget(
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
      expect(resolveWorkspaceDeleteTarget(state([target]), doc)).toBeNull()
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
      expectedInstanceId: 'instance-2'
    })
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
