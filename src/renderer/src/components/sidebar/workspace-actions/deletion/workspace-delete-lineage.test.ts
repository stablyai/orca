// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import {
  resolveWorktreeBatchDeleteTargets,
  toWorktreeDeleteIdentities
} from './worktree-delete-request'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { useDetachWorktreeDeleteChildren } from './use-detach-worktree-delete-children'
import {
  canPreserveWorkspaceDeleteChildren,
  workspaceDeleteTargetsMatch
} from './detach-worktree-delete-children'

const mocks = vi.hoisted(() => {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  const worktreeLineageById: Record<string, WorktreeLineage> = {}
  return {
    state: {
      worktreesByRepo,
      worktreeLineageById,
      updateWorktreeLineage: vi.fn<(id: string) => Promise<void>>()
    }
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
afterEach(cleanup)

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

const SSH_HOST: ExecutionHostId = toSshExecutionHostId('build-box')

describe('getWorkspaceDeleteLineage', () => {
  it('returns valid descendants for parent delete copy and child-first delete-all targets', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const grandchild = makeWorktree('grandchild', '/workspaces/parent/child/grandchild')

    const lineage = getWorkspaceDeleteLineage(parent, [parent, child, grandchild], {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    })

    expect(lineage.descendants.map((worktree) => worktree.id)).toEqual(['child', 'grandchild'])
    expect(lineage.directChildren.map((worktree) => worktree.id)).toEqual(['child'])
    expect(lineage.deleteAllTargets.map((worktree) => worktree.id)).toEqual([
      'grandchild',
      'child',
      'parent'
    ])
  })

  it('orders an exact inline-only legacy descendant before its parent', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, inlineChild], {})

    expect(lineage.descendants.map((worktree) => worktree.id)).toEqual([child.id])
    expect(lineage.deleteAllTargets.map((worktree) => worktree.id)).toEqual([child.id, parent.id])
  })

  it('keeps a stale side-map child authoritative over valid inline lineage', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, inlineChild], {
      [child.id]: {
        ...makeLineage(child, parent),
        parentWorktreeInstanceId: 'stale-parent-instance'
      }
    })

    expect(lineage.descendants).toEqual([])
    expect(lineage.deleteAllTargets).toEqual([parent])
  })

  it('resolves a colliding child id to the parent host', () => {
    const parent: Worktree = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshChild: Worktree = { ...localChild, hostId: SSH_HOST }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, localChild, sshChild], {
      [localChild.id]: makeLineage(localChild, parent)
    })

    expect(lineage.deleteAllTargets.map((worktree) => worktree.hostId)).toEqual([
      SSH_HOST,
      SSH_HOST
    ])
  })

  it('keeps the parent host preference stable regardless of row order', () => {
    const parent: Worktree = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshChild: Worktree = { ...localChild, hostId: SSH_HOST }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, sshChild, localChild], {
      [localChild.id]: makeLineage(localChild, parent)
    })

    expect(lineage.deleteAllTargets.map((worktree) => worktree.hostId)).toEqual([
      SSH_HOST,
      SSH_HOST
    ])
  })

  it('uses the confirmed host inline lineage when the bare projection belongs to the other host', () => {
    const localParent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      instanceId: 'local-parent',
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshParent: Worktree = {
      ...localParent,
      instanceId: 'ssh-parent',
      hostId: SSH_HOST
    }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      instanceId: 'local-child',
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshChildBase: Worktree = {
      ...localChild,
      instanceId: 'ssh-child',
      hostId: SSH_HOST
    }
    const sshChild = {
      ...sshChildBase,
      lineage: makeLineage(sshChildBase, sshParent)
    }

    const lineage = getWorkspaceDeleteLineage(
      sshParent,
      [localParent, sshParent, localChild, sshChild],
      { [localChild.id]: makeLineage(localChild, localParent) }
    )

    expect(lineage.deleteAllTargets).toEqual([sshChild, sshParent])
  })

  it('never targets a child known to live in another store; an unowned legacy child stays', () => {
    const serverParent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      hostId: toRuntimeExecutionHostId('build-box')
    }
    const legacyChild = makeWorktree('child', '/workspaces/parent/child')
    expect(
      getWorkspaceDeleteLineage(serverParent, [serverParent, legacyChild], {
        [legacyChild.id]: makeLineage(legacyChild, serverParent)
      }).deleteAllTargets.map((worktree) => worktree.id)
    ).toEqual(['child', 'parent'])

    const localParent: Worktree = { ...serverParent, hostId: LOCAL_EXECUTION_HOST_ID }
    const serverChild: Worktree = { ...legacyChild, runtimeOwnerEnvironmentId: 'build-box' }
    expect(
      getWorkspaceDeleteLineage(localParent, [localParent, serverChild], {
        [serverChild.id]: makeLineage(serverChild, localParent)
      }).deleteAllTargets.map((worktree) => worktree.id)
    ).toEqual(['parent'])
  })
})

describe('preserving children during workspace deletion', () => {
  it('retains the preservation choice until explicitly cleared when it becomes unavailable', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/child')
    const nested = makeWorktree('nested', '/workspaces/parent/nested')
    const lineage = getWorkspaceDeleteLineage(parent, [parent, child], {
      child: makeLineage(child, parent)
    })
    const hook = renderHook(
      ({ lineage }) =>
        useDetachWorktreeDeleteChildren({
          isOpen: true,
          parent,
          lineage,
          isFolderWorkspace: false,
          confirmedIdentities: toWorktreeDeleteIdentities([parent, child]),
          resolveConfirmedTargets: () => [parent, child]
        }),
      { initialProps: { lineage } }
    )

    act(() => hook.result.current.setPreserveChildren(true))
    expect(hook.result.current.preserveChildren).toBe(true)
    hook.rerender({
      lineage: getWorkspaceDeleteLineage(parent, [parent, child, nested], {
        child: makeLineage(child, parent),
        nested: makeLineage(nested, parent)
      })
    })

    expect(hook.result.current.canPreserveChildren).toBe(false)
    expect(hook.result.current.preserveChildrenSelected).toBe(true)
    expect(hook.result.current.preserveChildren).toBe(false)

    act(() => hook.result.current.setPreserveChildren(false))
    expect(hook.result.current.preserveChildrenSelected).toBe(false)
  })

  it('includes a main-worktree child in preservation confirmation without allowing its deletion', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = { ...makeWorktree('main', '/workspaces/main'), isMainWorktree: true }
    const lineage = getWorkspaceDeleteLineage(parent, [parent, child], {
      [child.id]: makeLineage(child, parent)
    })
    const requests = [parent, ...lineage.descendants]
    const lookup = (id: string) => requests.find((row) => row.id === id)

    expect(lineage.directChildren.map((row) => row.id)).toEqual(['main'])
    expect(resolveWorktreeBatchDeleteTargets(requests, lookup)?.map((row) => row.id)).toEqual([
      'parent'
    ])
    expect(
      resolveWorktreeBatchDeleteTargets(requests, lookup, { includeMainWorktrees: true })?.map(
        (row) => row.id
      )
    ).toEqual(['parent', 'main'])
  })

  it('refuses to preserve a folder child physically inside a Git parent on the same host', () => {
    const parent: Worktree = {
      ...makeWorktree('parent', 'C:\\workspaces\\parent'),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const child = makeWorktree('folder:child', 'C:\\workspaces\\parent\\child')

    expect(canPreserveWorkspaceDeleteChildren(parent, [child], false)).toBe(false)
    expect(canPreserveWorkspaceDeleteChildren(parent, [child], true)).toBe(true)
  })

  it('permits sibling directories and an identically located child on a different host', () => {
    const parent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sibling = makeWorktree('child', '/workspaces/parent-sibling')
    const remote = { ...makeWorktree('remote', '/workspaces/parent/child'), hostId: SSH_HOST }

    expect(canPreserveWorkspaceDeleteChildren(parent, [sibling, remote], false)).toBe(true)
  })

  it('treats an unstamped child as potentially belonging to its paired parent host', () => {
    const parent = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const child = makeWorktree('child', '/workspaces/parent/child')

    expect(canPreserveWorkspaceDeleteChildren(parent, [child], false)).toBe(false)
  })

  it('rejects unconfirmed descendants and same-ID replacements while allowing completed detachments', () => {
    const child = { ...makeWorktree('child', '/workspaces/child'), hostId: SSH_HOST }
    const grandchild = { ...makeWorktree('grandchild', '/workspaces/grandchild'), hostId: SSH_HOST }

    expect(workspaceDeleteTargetsMatch([child, grandchild], [grandchild])).toBe(true)
    expect(workspaceDeleteTargetsMatch([child], [{ ...child, instanceId: 'replacement' }])).toBe(
      false
    )
    expect(
      workspaceDeleteTargetsMatch([child], [{ ...child, hostId: LOCAL_EXECUTION_HOST_ID }])
    ).toBe(false)
    expect(workspaceDeleteTargetsMatch([child], [grandchild])).toBe(false)
  })
})

function renderPreservation(
  parent: Worktree,
  rows: Worktree[],
  edges: Record<string, WorktreeLineage>
) {
  mocks.state.worktreesByRepo = { 'repo-1': rows }
  mocks.state.worktreeLineageById = edges
  mocks.state.updateWorktreeLineage.mockReset().mockImplementation(async (id) => {
    const next = { ...mocks.state.worktreeLineageById }
    delete next[id]
    mocks.state.worktreeLineageById = next
    mocks.state.worktreesByRepo = {
      'repo-1': mocks.state.worktreesByRepo['repo-1'].map((row) =>
        row.id === id ? { ...row, lineage: null } : row
      )
    }
  })
  const lineage = getWorkspaceDeleteLineage(parent, rows, edges)
  return renderHook(() =>
    useDetachWorktreeDeleteChildren({
      isOpen: true,
      parent,
      lineage,
      isFolderWorkspace: false,
      confirmedIdentities: toWorktreeDeleteIdentities([parent, ...lineage.descendants]),
      resolveConfirmedTargets: (identities, expectedCount, options) => {
        const targets = resolveWorktreeBatchDeleteTargets(
          identities,
          (id, hostId) => getWorktreeOnHostFromState(mocks.state, id, hostId),
          options
        )
        return targets?.length === expectedCount ? targets : null
      }
    })
  )
}

describe('detaching before parent deletion', () => {
  it('keeps a newer parent assignment made after the dialog rendered', async () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/child')
    const other = makeWorktree('other', '/workspaces/other')
    const hook = renderPreservation(parent, [parent, child, other], {
      child: makeLineage(child, parent)
    })
    mocks.state.worktreeLineageById = { child: makeLineage(child, other) }
    const deleted: string[] = []

    await act(async () => hook.result.current.detachChildren(() => deleted.push('parent')))

    expect(mocks.state.worktreeLineageById.child.parentWorktreeId).toBe('other')
    expect(deleted).toEqual(['parent'])
    expect(hook.result.current.detachError).toBeNull()
  })

  it('uses the child host inline edge when the bare map belongs to a twin', async () => {
    const parent = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const childBase = { ...makeWorktree('child', '/workspaces/child'), hostId: SSH_HOST }
    const child = { ...childBase, lineage: makeLineage(childBase, parent) }
    const hook = renderPreservation(parent, [parent, child], {
      child: { ...makeLineage(child, parent), worktreeInstanceId: 'local-twin-instance' }
    })
    const deleted: string[] = []

    await act(async () => hook.result.current.detachChildren(() => deleted.push('parent')))

    expect(deleted).toEqual(['parent'])
    expect(hook.result.current.detachError).toBeNull()
  })

  it('keeps the parent when a child detachment fails', async () => {
    const parent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const child = makeWorktree('child', '/workspaces/child')
    const hook = renderPreservation(parent, [parent, child], { child: makeLineage(child, parent) })
    mocks.state.updateWorktreeLineage.mockRejectedValueOnce(new Error('Host disconnected'))
    const deleted: string[] = []

    await act(async () => hook.result.current.detachChildren(() => deleted.push('parent')))

    expect(deleted).toEqual([])
    expect(hook.result.current.detachError).not.toBeNull()
    expect(mocks.state.worktreeLineageById.child.parentWorktreeId).toBe('parent')
  })
})
