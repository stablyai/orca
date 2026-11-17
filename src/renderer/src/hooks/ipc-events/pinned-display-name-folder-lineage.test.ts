// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { replacedWorktreeRows } from '@/store/slices/worktrees/listing/worktree-catalog-membership'
import type * as CatalogMembership from '@/store/slices/worktrees/listing/worktree-catalog-membership'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import {
  selectCrossStoreFolderChildrenById,
  selectSidebarLineageParentIdentities
} from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { OWN_LINEAGE_STORE_KEY } from '../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { applyLocalPinnedDisplayName } from './pinned-display-name-apply'

import { TITLE, folderWorkspace, repo, row } from './pinned-display-name-test-fixtures'

vi.mock('@/store/slices/worktrees/listing/worktree-catalog-membership', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogMembership>()
  return { ...actual, replacedWorktreeRows: vi.fn(actual.replacedWorktreeRows) }
})

describe('applyLocalPinnedDisplayName folder lineage', () => {
  it.each([750, 7500])('a title pin re-reads no row for folder parents among %i rows', (size) => {
    let lineageReads = 0
    const rows = Array.from({ length: size }, (_, index) => {
      const worktree = row(size + 1, index, false, () => {})
      // Row 0 is renamed; count only the other rows' folder-lineage reads.
      Object.defineProperty(worktree, 'workspaceLineage', {
        get: () => {
          if (index !== 0) {
            lineageReads++
          }
          return undefined
        }
      })
      return worktree
    })
    const repoId = `repo-${size + 1}`
    const folder: FolderWorkspace = {
      id: 'folder-1',
      projectGroupId: 'group-1',
      name: 'Folder',
      folderPath: '/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    useAppStore.setState({
      repos: [repo(repoId)],
      worktreesByRepo: { [repoId]: rows },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folder],
      workspaceLineageByChildKey: {},
      crossStoreLineageByStoreKey: {},
      worktreeLineageById: {}
    })
    expect(selectSidebarLineageParentIdentities(useAppStore.getState())).toBeUndefined()
    lineageReads = 0

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    expect(selectSidebarLineageParentIdentities(useAppStore.getState())).toBeUndefined()
    expect(lineageReads).toBe(0)

    // A row that now carries a folder parent must not keep the cached undefined.
    const withFolderParent = {
      ...rows[5],
      workspaceLineage: {
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        childInstanceId: `instance-${size + 1}-5`
      }
    }
    const pinnedRows = useAppStore.getState().worktreesByRepo[repoId]
    useAppStore.setState({
      worktreesByRepo: {
        [repoId]: [...pinnedRows.slice(0, 5), withFolderParent, ...pinnedRows.slice(6)]
      }
    })
    const parents = selectSidebarLineageParentIdentities(useAppStore.getState())
    expect(parents?.has(getWorktreeHostIdentity(withFolderParent))).toBe(true)
  })

  it('re-resolves folder parents when only the runtime owner changes', () => {
    const child: Worktree = { ...row(18, 0, false, () => {}), repoId: 'repo-18' }
    const withFolderParent = {
      ...child,
      workspaceLineage: {
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        childInstanceId: 'instance-18-0'
      }
    }
    useAppStore.setState({
      repos: [repo('repo-18')],
      worktreesByRepo: { 'repo-18': [withFolderParent] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folderWorkspace('folder-1')],
      workspaceLineageByChildKey: {},
      crossStoreLineageByStoreKey: {},
      worktreeLineageById: {}
    })
    const identity = getWorktreeHostIdentity(withFolderParent)
    expect(selectSidebarLineageParentIdentities(useAppStore.getState())?.has(identity)).toBe(true)

    const runtimeOwned = { ...withFolderParent, runtimeOwnerEnvironmentId: 'env-1' }
    useAppStore.setState({ worktreesByRepo: { 'repo-18': [runtimeOwned] } })
    // A cold resolution files the row under env-1's store, where folder-1 is not listed.
    expect(
      selectSidebarLineageParentIdentities(useAppStore.getState())?.has(identity) ?? false
    ).toBe(false)
  })

  it('re-resolves parents when only a row inline lineage moves', () => {
    const [a, b, c] = Array.from({ length: 3 }, (_, index) => row(20, index, false, () => {}))
    const inlineLineage = (parent: Worktree): WorktreeLineage => ({
      worktreeId: c.id,
      worktreeInstanceId: 'instance-20-2',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId ?? '',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 0
    })
    // A real folder edge on A keeps the selector resolving instead of returning undefined.
    const aInFolder = {
      ...a,
      workspaceLineage: {
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        childInstanceId: 'instance-20-0'
      }
    }
    const cUnderA = { ...c, lineage: inlineLineage(a) }
    useAppStore.setState({
      repos: [repo('repo-20')],
      worktreesByRepo: { 'repo-20': [aInFolder, b, cUnderA] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folderWorkspace('folder-1')],
      workspaceLineageByChildKey: {},
      crossStoreLineageByStoreKey: {},
      worktreeLineageById: {}
    })
    const cIdentity = getWorktreeHostIdentity(c)
    expect(selectSidebarLineageParentIdentities(useAppStore.getState())?.get(cIdentity)).toBe(
      getWorktreeHostIdentity(a)
    )

    const cUnderB = { ...cUnderA, lineage: inlineLineage(b) }
    useAppStore.setState({ worktreesByRepo: { 'repo-20': [aInFolder, b, cUnderB] } })
    expect(selectSidebarLineageParentIdentities(useAppStore.getState())?.get(cIdentity)).toBe(
      getWorktreeHostIdentity(b)
    )
  })

  it.each([750, 7500])('a title pin resolves no folder children among %i rows', (size) => {
    let hostReads = 0
    const rows = Array.from({ length: size }, (_, index) => {
      const worktree = row(size + 2, index, false, () => {})
      // Row 0 is renamed; count only the other rows' host reads, which resolution does per row.
      Object.defineProperty(worktree, 'hostId', {
        get: () => {
          if (index !== 0) {
            hostReads++
          }
          return undefined
        }
      })
      return worktree
    })
    const repoId = `repo-${size + 2}`
    // A saved edge to a folder in a store that is not available resolves to no child.
    const childKey = worktreeWorkspaceKey(rows[5].id)
    useAppStore.setState({
      repos: [repo(repoId)],
      worktreesByRepo: { [repoId]: rows },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folderWorkspace('folder-1')],
      workspaceLineageByChildKey: {},
      worktreeLineageById: {},
      crossStoreLineageByStoreKey: {
        [OWN_LINEAGE_STORE_KEY]: {
          [childKey]: {
            childWorkspaceKey: childKey,
            childInstanceId: `instance-${size + 2}-5`,
            parent: {
              installationId: 'unavailable-store',
              workspaceKey: folderWorkspaceKey('folder-1'),
              instanceId: 'folder-1'
            },
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 0
          }
        }
      }
    })
    const warm = selectCrossStoreFolderChildrenById(useAppStore.getState())
    expect(warm.size).toBe(0)
    // The cold resolution does read every other row.
    expect(hostReads).toBeGreaterThanOrEqual(size - 1)
    hostReads = 0

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    expect(selectCrossStoreFolderChildrenById(useAppStore.getState())).toBe(warm)
    expect(hostReads).toBe(0)
  })

  it.each([750, 7500])('an unrelated rename keeps %i resolved folder children', (size) => {
    let childHostReads = 0
    const children = Array.from({ length: size }, (_, index) => {
      const child = row(size + 4, index, false, () => {})
      Object.defineProperty(child, 'hostId', {
        enumerable: true,
        get: () => {
          childHostReads++
          return LOCAL_EXECUTION_HOST_ID
        }
      })
      return child
    })
    const unrelated: Worktree = {
      ...row(size + 5, 0, false, () => {}),
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const childRepoId = `repo-${size + 4}`
    const localRepoId = `repo-${size + 5}`
    const records = Object.fromEntries(
      children.map((child, index) => {
        const childKey = worktreeWorkspaceKey(child.id)
        return [
          childKey,
          {
            childWorkspaceKey: childKey,
            childInstanceId: `instance-${size + 4}-${index}`,
            parent: {
              installationId: 'own-install',
              workspaceKey: folderWorkspaceKey('folder-1'),
              instanceId: 'folder-1'
            },
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 0
          }
        ]
      })
    )
    useAppStore.setState({
      repos: [repo(childRepoId), repo(localRepoId)],
      worktreesByRepo: { [childRepoId]: children, [localRepoId]: [unrelated] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folderWorkspace('folder-1')],
      workspaceLineageByChildKey: {},
      worktreeLineageById: {},
      ownLineageInstallationId: 'own-install',
      crossStoreLineageByStoreKey: { [OWN_LINEAGE_STORE_KEY]: records }
    })
    const warm = selectCrossStoreFolderChildrenById(useAppStore.getState())
    expect(warm.get('folder-1')).toHaveLength(size)
    childHostReads = 0

    for (const title of ['Unrelated one', 'Unrelated two']) {
      applyLocalPinnedDisplayName({ worktreeId: unrelated.id, displayName: title })
      expect(selectCrossStoreFolderChildrenById(useAppStore.getState())).toBe(warm)
    }
    expect(childHostReads).toBe(0)

    // Retitling a child returns a new map with that child's title; the others stay the same rows.
    applyLocalPinnedDisplayName({ worktreeId: children[0].id, displayName: TITLE })
    const retitled = selectCrossStoreFolderChildrenById(useAppStore.getState())
    expect(retitled).not.toBe(warm)
    const folderChildren = retitled.get('folder-1') ?? []
    expect(folderChildren.find(({ id }) => id === children[0].id)?.displayName).toBe(TITLE)
    expect(folderChildren.find(({ id }) => id === children[1].id)).toBe(children[1])
  })

  it.each([750, 7500])(
    'folder children reuse the index replacement list beside %i local rows',
    (size) => {
      const child: Worktree = {
        ...row(size + 6, 0, false, () => {}),
        hostId: LOCAL_EXECUTION_HOST_ID
      }
      const localRows = Array.from({ length: size }, (_, index) =>
        row(size + 7, index, false, () => {})
      )
      const childKey = worktreeWorkspaceKey(child.id)
      const localRepoId = `repo-${size + 7}`
      useAppStore.setState({
        repos: [repo(`repo-${size + 6}`), repo(localRepoId)],
        worktreesByRepo: { [`repo-${size + 6}`]: [child], [localRepoId]: localRows },
        detectedWorktreesByRepo: {},
        folderWorkspaces: [folderWorkspace('folder-1')],
        workspaceLineageByChildKey: {},
        worktreeLineageById: {},
        ownLineageInstallationId: 'own-install',
        crossStoreLineageByStoreKey: {
          [OWN_LINEAGE_STORE_KEY]: {
            [childKey]: {
              childWorkspaceKey: childKey,
              childInstanceId: `instance-${size + 6}-0`,
              parent: {
                installationId: 'own-install',
                workspaceKey: folderWorkspaceKey('folder-1'),
                instanceId: 'folder-1'
              },
              origin: 'manual',
              capture: { source: 'manual-action', confidence: 'explicit' },
              createdAt: 0
            }
          }
        }
      })
      const warm = selectCrossStoreFolderChildrenById(useAppStore.getState())
      expect(warm.get('folder-1')).toEqual([child])
      const slotWalks = vi.mocked(replacedWorktreeRows)

      for (const title of ['Local one', 'Local two']) {
        applyLocalPinnedDisplayName({ worktreeId: localRows[3].id, displayName: title })
        // The shared index walks this write once; the selector must not walk it again.
        getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)
        slotWalks.mockClear()
        expect(selectCrossStoreFolderChildrenById(useAppStore.getState())).toBe(warm)
        expect(slotWalks).toHaveBeenCalledTimes(0)
      }
    }
  )
})
