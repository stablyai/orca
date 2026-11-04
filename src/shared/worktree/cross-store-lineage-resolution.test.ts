import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId } from '../execution-host'
import { getSidebarLineageParentsByIdentity } from '../sidebar-list/worktree-lineage-projection'
import { getWorktreeHostIdentity } from './host-qualified-identity'
import type { CrossStoreLineageView, LineageStoreView } from './cross-store-lineage-resolution'
import type { CrossStoreWorkspaceLineage, WorktreeLineage } from './lineage-types'
import type { Worktree } from './types'

const MAC_INSTALL = '5f2a0000-0000-4000-8000-000000000001'
const SERVER_INSTALL = '5f2a0000-0000-4000-8000-000000000002'

function row(id: string, instanceId: string, environmentId?: string): Worktree {
  return {
    id,
    instanceId,
    repoId: id.split('::')[0],
    ...(environmentId ? { hostId: toRuntimeExecutionHostId(environmentId) } : {}),
    path: id.split('::')[1],
    head: 'abc',
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

function link(child: Worktree, parentInstallationId: string, parent: Worktree) {
  const lineage: CrossStoreWorkspaceLineage = {
    childWorkspaceKey: `worktree:${child.id}`,
    childInstanceId: child.instanceId ?? '',
    parent: {
      installationId: parentInstallationId,
      workspaceKey: `worktree:${parent.id}`,
      instanceId: parent.instanceId ?? ''
    },
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  return { [lineage.childWorkspaceKey]: lineage }
}

function store(
  installationId: string,
  crossStoreLineageByChildKey: Record<string, unknown> = {}
): LineageStoreView {
  return { installationId, crossStoreLineageByChildKey }
}

function parentIdsOf(
  rows: Worktree[],
  view: CrossStoreLineageView,
  lineageById: Record<string, WorktreeLineage> = {}
): Record<string, string> {
  const byIdentity = new Map<string, Worktree>(
    rows.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  return Object.fromEntries(
    [...getSidebarLineageParentsByIdentity(lineageById, byIdentity, view)].map(
      ([identity, parent]) => [byIdentity.get(identity)?.id, parent.id]
    )
  )
}

describe('cross-store parent resolution', () => {
  const macParent = row('repo3::/src/fix-login', 'parent-7c1e')
  const serverChild = row('repo9::/work/fix-login-tests', 'child-b40d', 'build-box')
  const records = link(serverChild, MAC_INSTALL, macParent)

  it('nests under the one visible store with the parent installationId, else standalone', () => {
    expect(
      parentIdsOf(
        [macParent, serverChild],
        new Map([
          ['', store(MAC_INSTALL)],
          ['build-box', store(SERVER_INSTALL, records)]
        ])
      )
    ).toEqual({ 'repo9::/work/fix-login-tests': 'repo3::/src/fix-login' })

    const copiedMac = row('repo3::/src/fix-login', 'parent-7c1e', 'copy-box')
    expect(
      parentIdsOf(
        [macParent, copiedMac, serverChild],
        new Map([
          ['', store(MAC_INSTALL)],
          ['copy-box', store(MAC_INSTALL)],
          ['build-box', store(SERVER_INSTALL, records)]
        ])
      )
    ).toEqual({})

    const recreatedChild = { ...serverChild, instanceId: 'child-new' }
    expect(
      parentIdsOf(
        [macParent, recreatedChild],
        new Map([
          ['', store(MAC_INSTALL)],
          ['build-box', store(SERVER_INSTALL, records)]
        ])
      )
    ).toEqual({})
  })

  it('resolves within the child store when both ends share it; a same-store edge wins', () => {
    const serverParent = row('repo9::/work/fix-login', 'parent-7c1e', 'build-box')
    const view = new Map([
      ['', store(MAC_INSTALL)],
      ['build-box', store(SERVER_INSTALL, link(serverChild, SERVER_INSTALL, serverParent))]
    ])
    expect(parentIdsOf([macParent, serverParent, serverChild], view)).toEqual({
      'repo9::/work/fix-login-tests': 'repo9::/work/fix-login'
    })

    const sibling = row('repo9::/work/sibling', 'sibling-1', 'build-box')
    const sameStore: WorktreeLineage = {
      worktreeId: serverChild.id,
      worktreeInstanceId: 'child-b40d',
      parentWorktreeId: sibling.id,
      parentWorktreeInstanceId: 'sibling-1',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    expect(
      parentIdsOf([serverParent, sibling, serverChild], view, { [serverChild.id]: sameStore })
    ).toEqual({ 'repo9::/work/fix-login-tests': 'repo9::/work/sibling' })
  })
})
