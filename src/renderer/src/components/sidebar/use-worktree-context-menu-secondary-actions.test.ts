// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceKey } from '../../../../shared/folder-workspace-types'
import { useWorktreeContextMenuSecondaryActions } from './use-worktree-context-menu-secondary-actions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

function row(id: string): Worktree {
  return { id, instanceId: `${id}-instance`, displayName: id } as Worktree
}

function worktreeLineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function workspaceLineage(childId: string, parentKey: WorkspaceKey): WorkspaceLineage {
  return {
    childWorkspaceKey: `worktree:${childId}`,
    parentWorkspaceKey: parentKey,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function detachedIds(args: {
  selected: readonly Worktree[]
  worktreeLineageById?: AppState['worktreeLineageById']
  workspaceLineageByChildKey?: AppState['workspaceLineageByChildKey']
}): string[] {
  const updateWorktreeLineage = vi.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() =>
    useWorktreeContextMenuSecondaryActions({
      activeContextWorktrees: args.selected,
      contextMenuOpenedAtRef: { current: null },
      updateWorktreeLineage,
      worktreeLineageById: args.worktreeLineageById ?? {},
      workspaceLineageByChildKey: args.workspaceLineageByChildKey ?? {}
    })
  )
  result.current.handleRemoveParentLink()
  for (const call of updateWorktreeLineage.mock.calls) {
    expect(call[1]).toEqual({ noParent: true })
  }
  return updateWorktreeLineage.mock.calls.map((call) => call[0] as string).sort()
}

describe('bulk Remove from Parent targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detaches only the linked child whose parent is not selected', () => {
    // Selection: a child of an unselected parent, an unrelated top-level row,
    // and a parent selected together with its own child.
    expect(
      detachedIds({
        selected: [
          row('repo::child-1'),
          row('repo::top'),
          row('repo::parent-2'),
          row('repo::child-2')
        ],
        worktreeLineageById: {
          'repo::child-1': worktreeLineage('repo::child-1', 'repo::parent-1'),
          'repo::child-2': worktreeLineage('repo::child-2', 'repo::parent-2')
        }
      })
    ).toEqual(['repo::child-1'])
  })

  it('keeps a selected subtree intact and detaches only its root from the outside parent', () => {
    expect(
      detachedIds({
        selected: [row('repo::parent'), row('repo::child'), row('repo::grandchild')],
        worktreeLineageById: {
          'repo::parent': worktreeLineage('repo::parent', 'repo::grandparent'),
          'repo::child': worktreeLineage('repo::child', 'repo::parent'),
          'repo::grandchild': worktreeLineage('repo::grandchild', 'repo::child')
        }
      })
    ).toEqual(['repo::parent'])
  })

  it('does not send a worktree-lineage detach to a selected folder workspace', () => {
    // Why: the folder row carries a stray lineage record, so only the folder guard
    // (not the unlinked-row skip) keeps it out of the detach.
    expect(
      detachedIds({
        selected: [row('folder:folder-1'), row('repo::child')],
        worktreeLineageById: {
          'folder:folder-1': worktreeLineage('folder:folder-1', 'repo::parent'),
          'repo::child': worktreeLineage('repo::child', 'repo::parent')
        }
      })
    ).toEqual(['repo::child'])
  })

  it('detaches a row whose stale worktree link points at itself', () => {
    expect(
      detachedIds({
        selected: [row('repo::self'), row('repo::top')],
        worktreeLineageById: {
          'repo::self': worktreeLineage('repo::self', 'repo::self')
        }
      })
    ).toEqual(['repo::self'])
  })

  it('detaches a row whose stale workspace link points at itself', () => {
    expect(
      detachedIds({
        selected: [row('repo::self'), row('repo::top')],
        workspaceLineageByChildKey: {
          'worktree:repo::self': workspaceLineage('repo::self', 'worktree:repo::self')
        }
      })
    ).toEqual(['repo::self'])
  })

  it('keeps a worktree attached to a selected folder workspace', () => {
    expect(
      detachedIds({
        selected: [row('folder:folder-1'), row('repo::attached'), row('repo::other')],
        workspaceLineageByChildKey: {
          'worktree:repo::attached': workspaceLineage('repo::attached', 'folder:folder-1'),
          'worktree:repo::other': workspaceLineage('repo::other', 'folder:folder-2')
        }
      })
    ).toEqual(['repo::other'])
  })

  it('detaches nothing when no selected row has a parent outside the selection', () => {
    expect(
      detachedIds({
        selected: [row('repo::parent'), row('repo::child'), row('repo::top')],
        worktreeLineageById: {
          'repo::child': worktreeLineage('repo::child', 'repo::parent')
        }
      })
    ).toEqual([])
  })

  it('still detaches a single linked row', () => {
    expect(
      detachedIds({
        selected: [row('repo::child')],
        worktreeLineageById: {
          'repo::child': worktreeLineage('repo::child', 'repo::parent')
        }
      })
    ).toEqual(['repo::child'])
  })
})
