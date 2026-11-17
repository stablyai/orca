// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import { renderHook } from '@testing-library/react'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeMap,
  getIndexedWorktreesById,
  getIndexedWorktreeTopology
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { useTerminalWorkspaceFoundation } from '@/components/use-terminal-workspace-foundation'
import { projectWorkspaceSurfaces } from '@/components/workspace-surface-projection'
import type * as SurfaceProjection from '@/components/workspace-surface-projection'
import {
  useAllWorktrees,
  useWorktreeMap
} from '@/store/slices/worktrees/listing/use-worktree-catalog'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  selectCrossStoreFolderChildrenById,
  selectSidebarLineageParentIdentities
} from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { OWN_LINEAGE_STORE_KEY } from '../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  getCyclicProjectedWorktreeLineageIds,
  getSidebarLineageParentsByIdentity
} from '../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { computeVisibleWorktrees } from '@/components/sidebar/worktree-list/listing/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/worktree-list/listing/visible-worktree-options-from-state'
import { subscribeStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { resolveStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type * as ChatTabName from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { getLineageAncestorIndex } from '@/components/sidebar/worktree-list/listing/visible-worktree-indexes'
import { applyLocalPinnedDisplayName } from './pinned-display-name-apply'

vi.mock('@/runtime/native-chat/naming/structured-chat-tab-name', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatTabName>()
  return { ...actual, resolveStructuredChatTabName: vi.fn(actual.resolveStructuredChatTabName) }
})

vi.mock('@/components/workspace-surface-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof SurfaceProjection>()
  return { ...actual, projectWorkspaceSurfaces: vi.fn(actual.projectWorkspaceSurfaces) }
})

const TITLE = 'Triage assigned issues prs'

function folderWorkspace(id: string): FolderWorkspace {
  return {
    id,
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
}
const CHAT_TABS = 100

/** Counts full walks of an index, which is how a copy reads it. */
function countIterations(target: Map<string, Worktree> | Worktree[]): () => number {
  let walks = 0
  const iterate = target[Symbol.iterator].bind(target)
  Object.defineProperty(target, Symbol.iterator, {
    configurable: true,
    value: () => {
      walks++
      return iterate()
    }
  })
  return () => walks
}

function repo(id: string): Repo {
  return { id, path: '/work', displayName: id, badgeColor: '#000000', addedAt: 0 }
}

function chatTab(worktreeId: string, index: number): Tab {
  return {
    id: `chat-${index}`,
    entityId: `chat-${index}`,
    groupId: `group-${index}`,
    worktreeId,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: `Chat ${index}`,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0
  }
}

function row(size: number, index: number, isArchived: boolean, onRead: () => void): Worktree {
  const worktree: Worktree = {
    id: `repo-${size}::/work/w${index}`,
    repoId: `repo-${size}`,
    path: `/work/w${index}`,
    head: 'aaa',
    branch: `refs/heads/w${index}`,
    isBare: false,
    isMainWorktree: false,
    displayName: index === 0 ? 'batfish-2' : `w${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    instanceId: `instance-${size}-${index}`
  }
  Object.defineProperty(worktree, 'isArchived', {
    enumerable: true,
    get: () => {
      onRead()
      return isArchived
    }
  })
  return worktree
}

describe('applyLocalPinnedDisplayName', () => {
  it.each([750, 7500])('pins one title among %i rows without rescanning the catalog', (size) => {
    let otherReads = 0
    const countOtherRead = (): void => {
      otherReads++
    }
    // Row 0 is renamed and row 1 archived below; only the other rows' reads count.
    const rows = Array.from({ length: size }, (_, index) =>
      row(size, index, false, index < 2 ? () => {} : countOtherRead)
    )
    const repoId = `repo-${size}`
    // Chats live on rows 2..101, never on the renamed or archived row.
    const unifiedTabsByWorktree = Object.fromEntries(
      Array.from({ length: CHAT_TABS }, (_, index) => {
        const worktreeId = rows[index + 2].id
        return [worktreeId, [chatTab(worktreeId, index)]]
      })
    )
    // Row 3 nests under the renamed row 0.
    const lineageById: Record<string, WorktreeLineage> = {
      [rows[3].id]: {
        worktreeId: rows[3].id,
        worktreeInstanceId: `instance-${size}-3`,
        parentWorktreeId: rows[0].id,
        parentWorktreeInstanceId: `instance-${size}-0`,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    }
    useAppStore.setState({
      repos: [repo(repoId)],
      worktreesByRepo: { [repoId]: rows },
      detectedWorktreesByRepo: {},
      worktreeLineageById: lineageById,
      unifiedTabsByWorktree
    })
    const warmMap = getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)
    const warmRows = getIndexedAllWorktrees(useAppStore.getState().worktreesByRepo)
    const warmLineage = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    const warmTopology = getIndexedWorktreeTopology(useAppStore.getState().worktreesByRepo)
    const warmCycles = getCyclicProjectedWorktreeLineageIds(lineageById, warmTopology)
    const warmParents = getSidebarLineageParentsByIdentity(lineageById, warmLineage)
    const terminal = renderHook(() => useTerminalWorkspaceFoundation())
    const projections = vi.mocked(projectWorkspaceSurfaces)
    projections.mockClear()
    const stopNames = subscribeStructuredChatTabNames(() => {})
    const resolvedNames = vi.mocked(resolveStructuredChatTabName)
    let senderLocations = 0
    const stopSenders = useAppStore
      .getState()
      .agentStatusByPaneKey.projection.subscribe('sender-locations', () => {
        senderLocations++
      })
    let writes = 0
    const stopWrites = useAppStore.subscribe(() => {
      writes++
    })
    const mapCopies = countIterations(warmMap)
    const lineageCopies = countIterations(warmLineage)
    const rowCopies = countIterations(warmRows)
    otherReads = 0
    resolvedNames.mockClear()

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    const pinned = useAppStore.getState().worktreesByRepo
    expect(resolvedNames).toHaveBeenCalledTimes(0)
    // New views for memo deps, over the untouched warm indexes.
    const pinnedMap = getIndexedWorktreeMap(pinned)
    expect(pinnedMap).not.toBe(warmMap)
    expect(pinnedMap.get(rows[0].id)).toMatchObject({
      displayName: TITLE,
      displayNameMode: 'fixed'
    })
    expect(warmMap.get(rows[0].id)?.displayName).toBe('batfish-2')
    // A title is not a lineage change: the structural maps and their cycle and parent caches hold.
    const pinnedTopology = getIndexedWorktreeTopology(pinned)
    const pinnedLineage = getLineageAncestorIndex(pinned)
    expect(pinnedTopology).toBe(warmTopology)
    expect(pinnedLineage).toBe(warmLineage)
    expect(getCyclicProjectedWorktreeLineageIds(lineageById, pinnedTopology)).toBe(warmCycles)
    expect(getSidebarLineageParentsByIdentity(lineageById, pinnedLineage)).toBe(warmParents)
    expect(mapCopies()).toBe(0)
    expect(lineageCopies()).toBe(0)
    // Surfaces read ids and paths only: the title write keeps the topology and skips the projection.
    expect(getIndexedWorktreeTopology(pinned)).toBe(warmTopology)
    terminal.rerender()
    expect(projections).toHaveBeenCalledTimes(0)
    // No subscriber has read the row list yet, so it is not copied.
    expect(rowCopies()).toBe(0)

    // Two subscribers share one pointer copy of the row list.
    const first = renderHook(() => useAllWorktrees())
    const second = renderHook(() => useAllWorktrees())
    expect(first.result.current).toBe(second.result.current)
    expect(first.result.current).not.toBe(warmRows)
    expect(first.result.current).toHaveLength(size)
    expect(first.result.current[0].displayName).toBe(TITLE)
    expect(rowCopies()).toBe(1)
    expect(renderHook(() => useWorktreeMap()).result.current).toBe(pinnedMap)
    expect(mapCopies()).toBe(0)
    expect(otherReads).toBe(0)
    // Ten walks of the pin's overlay read its base once.
    for (let walk = 0; walk < 10; walk++) {
      expect([...pinnedMap.entries()]).toHaveLength(size)
    }
    expect(mapCopies()).toBe(1)

    // Row 0 is hidden as sleeping and drawn only as row 3's ancestor, with its new title.
    const visibleOptions = {
      ...buildVisibleWorktreeOptionsFromState(
        useAppStore.getState(),
        new Map([[repoId, repo(repoId)]])
      ),
      showSleepingWorkspaces: false,
      forcedVisibleWorktreeIds: [rows[3].id]
    }
    expect(
      computeVisibleWorktrees(pinned, [], { ...visibleOptions, injectLineageAncestors: false }).map(
        ({ id }) => id
      )
    ).toEqual([rows[3].id])
    const withAncestor = computeVisibleWorktrees(pinned, [], visibleOptions)
    expect(withAncestor.map(({ id }) => id)).toEqual([rows[0].id, rows[3].id])
    expect(withAncestor[0].displayName).toBe(TITLE)
    expect(senderLocations).toBe(0)
    // The pin and any sort-settle write it triggers; the identical pin below must add none.
    const writesAfterPin = writes
    expect(writesAfterPin).toBeGreaterThan(0)

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    expect(useAppStore.getState().worktreesByRepo).toBe(pinned)
    expect(writes).toBe(writesAfterPin)
    expect(senderLocations).toBe(0)

    const archived = row(size, 1, true, () => {})
    useAppStore.setState({
      worktreesByRepo: { [repoId]: [pinned[repoId][0], archived, ...rows.slice(2)] }
    })
    expect(senderLocations).toBe(1)
    expect(resolvedNames).toHaveBeenCalledTimes(CHAT_TABS)
    otherReads = 0
    const lineage = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    expect([...lineage.values()].some(({ id }) => id === archived.id)).toBe(false)
    expect(otherReads).toBe(size - 2)

    expect(getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)).not.toBe(warmMap)

    stopNames()
    stopSenders()
    stopWrites()
    first.unmount()
    second.unmount()
    terminal.unmount()
  })

  it('rebuilds the topology for a path change and keeps unchanged rows', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(11, index, false, () => {}))
    useAppStore.setState({ worktreesByRepo: { 'repo-11': rows }, detectedWorktreesByRepo: {} })
    const before = getIndexedWorktreeTopology(useAppStore.getState().worktreesByRepo)
    const terminal = renderHook(() => useTerminalWorkspaceFoundation())
    const projections = vi.mocked(projectWorkspaceSurfaces)
    projections.mockClear()

    useAppStore.setState({
      worktreesByRepo: { 'repo-11': [{ ...rows[0], path: '/moved/w0' }, ...rows.slice(1)] }
    })
    const after = getIndexedWorktreeTopology(useAppStore.getState().worktreesByRepo)
    expect(after).not.toBe(before)
    expect(after.get(rows[0].id)?.path).toBe('/moved/w0')
    expect(after.get(rows[1].id)).toBe(rows[1])
    expect(before.get(rows[0].id)?.path).toBe('/work/w0')
    terminal.rerender()
    expect(projections).toHaveBeenCalledTimes(1)
    const surfaces = terminal.result.current.workspaceSurfaces
    expect(surfaces).toHaveLength(10)
    expect(surfaces.find(({ id }) => id === rows[0].id)?.path).toBe('/moved/w0')
    terminal.unmount()
  })

  it('keeps both renamed twins in one id list across batched and single renames', () => {
    const twinId = 'repo-twin::/work/twin'
    const local: Worktree = {
      ...row(12, 0, false, () => {}),
      id: twinId,
      repoId: 'repo-twin',
      displayName: 'Local A'
    }
    const ssh: Worktree = { ...local, hostId: 'ssh:box', displayName: 'SSH A' }
    useAppStore.setState({
      worktreesByRepo: { 'repo-twin': [local, ssh] },
      detectedWorktreesByRepo: {}
    })
    getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)

    const renamedLocal = { ...local, displayName: 'Renamed' }
    const renamedSsh = { ...ssh, displayName: 'Renamed' }
    useAppStore.setState({ worktreesByRepo: { 'repo-twin': [renamedLocal, renamedSsh] } })
    const batched = useAppStore.getState().worktreesByRepo
    expect(getIndexedAllWorktrees(batched).map(({ displayName }) => displayName)).toEqual([
      'Renamed',
      'Renamed'
    ])
    expect(getIndexedWorktreesById(batched, twinId).map(({ displayName }) => displayName)).toEqual([
      'Renamed',
      'Renamed'
    ])

    useAppStore.setState({
      worktreesByRepo: { 'repo-twin': [{ ...renamedLocal, displayName: 'Local B' }, renamedSsh] }
    })
    const single = useAppStore.getState().worktreesByRepo
    expect(getIndexedWorktreesById(single, twinId).map(({ displayName }) => displayName)).toEqual([
      'Local B',
      'Renamed'
    ])
  })

  it('indexing an older catalog leaves the newer one on its own title', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(10, index, false, () => {}))
    useAppStore.setState({ worktreesByRepo: { 'repo-10': rows }, detectedWorktreesByRepo: {} })
    getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)
    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    const older = useAppStore.getState().worktreesByRepo
    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: 'Second title' })
    const newer = useAppStore.getState().worktreesByRepo

    expect(getIndexedWorktreeMap(newer).get(rows[0].id)?.displayName).toBe('Second title')
    expect(getIndexedWorktreeMap(older).get(rows[0].id)?.displayName).toBe(TITLE)
    expect(getIndexedWorktreeMap(newer).get(rows[0].id)?.displayName).toBe('Second title')
    expect(getIndexedAllWorktrees(newer)[0].displayName).toBe('Second title')
  })

  it('applies a structural write that follows a kept title write to the lineage index', () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(13, index, false, () => {}))
    const identity = getWorktreeHostIdentity(rows[0])
    useAppStore.setState({ worktreesByRepo: { 'repo-13': rows }, detectedWorktreesByRepo: {} })
    const c0 = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)

    const titled = { ...rows[0], displayName: 'T' }
    useAppStore.setState({ worktreesByRepo: { 'repo-13': [titled, ...rows.slice(1)] } })
    expect(getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)).toBe(c0)

    const moved = { ...titled, path: '/moved', instanceId: 'instance-new' }
    useAppStore.setState({ worktreesByRepo: { 'repo-13': [moved, ...rows.slice(1)] } })
    const c2 = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    expect(c2.get(identity)).toMatchObject({ path: '/moved', instanceId: 'instance-new' })
    expect(c0.get(identity)).toMatchObject({ path: '/work/w0', instanceId: 'instance-13-0' })

    // A child recorded on the new instance nests under it.
    const lineageById: Record<string, WorktreeLineage> = {
      [rows[1].id]: {
        worktreeId: rows[1].id,
        worktreeInstanceId: 'instance-13-1',
        parentWorktreeId: rows[0].id,
        parentWorktreeInstanceId: 'instance-new',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    }
    expect(
      getSidebarLineageParentsByIdentity(lineageById, c2).get(getWorktreeHostIdentity(rows[1]))
        ?.path
    ).toBe('/moved')
  })

  it('keeps a forced-visible row hidden once it is retired after a title pin', () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(14, index, false, () => {}))
    useAppStore.setState({
      repos: [repo('repo-14')],
      worktreesByRepo: { 'repo-14': rows },
      detectedWorktreesByRepo: {},
      worktreeLineageById: {}
    })
    getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    applyLocalPinnedDisplayName({ worktreeId: rows[2].id, displayName: TITLE })
    const options = {
      ...buildVisibleWorktreeOptionsFromState(
        useAppStore.getState(),
        new Map([['repo-14', repo('repo-14')]])
      ),
      showSleepingWorkspaces: false,
      forcedVisibleWorktreeIds: [rows[2].id]
    }
    const pinned = useAppStore.getState().worktreesByRepo
    const shown = computeVisibleWorktrees(pinned, [], options)
    expect(shown.map(({ id, displayName }) => [id, displayName])).toEqual([[rows[2].id, TITLE]])

    const retired: Worktree = { ...pinned['repo-14'][2], removing: true, removalRecorded: true }
    useAppStore.setState({
      worktreesByRepo: { 'repo-14': [...rows.slice(0, 2), retired, ...rows.slice(3)] }
    })
    const afterRetire = useAppStore.getState().worktreesByRepo
    expect(getLineageAncestorIndex(afterRetire)).toBe(getLineageAncestorIndex(pinned))
    expect(computeVisibleWorktrees(afterRetire, [], options)).toEqual([])
  })

  it('keeps the topology through a title-only overlay compaction', () => {
    const rows = Array.from({ length: 750 }, (_, index) => row(15, index, false, () => {}))
    useAppStore.setState({ worktreesByRepo: { 'repo-15': rows }, detectedWorktreesByRepo: {} })
    const warmTopology = getIndexedWorktreeTopology(useAppStore.getState().worktreesByRepo)
    const terminal = renderHook(() => useTerminalWorkspaceFoundation())
    const projections = vi.mocked(projectWorkspaceSurfaces)
    projections.mockClear()

    // 65 distinct rows pass the 64-row overlay, so the title catalog compacts once.
    for (let index = 0; index < 65; index++) {
      applyLocalPinnedDisplayName({ worktreeId: rows[index].id, displayName: `Title ${index}` })
      getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)
    }
    const latest = useAppStore.getState().worktreesByRepo
    expect(getIndexedWorktreeTopology(latest)).toBe(warmTopology)
    expect(getIndexedWorktreeMap(latest).get(rows[64].id)?.displayName).toBe('Title 64')
    terminal.rerender()
    expect(projections).toHaveBeenCalledTimes(0)
    terminal.unmount()
  })

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

  it('keeps the winning copy in the lineage index when a discarded copy moves', () => {
    const rows = Array.from({ length: 4 }, (_, index) => row(17, index, false, () => {}))
    const winner: Worktree = { ...rows[0] }
    useAppStore.setState({
      worktreesByRepo: { 'repo-17': [...rows, winner] },
      detectedWorktreesByRepo: {}
    })
    const identity = getWorktreeHostIdentity(winner)
    expect(getLineageAncestorIndex(useAppStore.getState().worktreesByRepo).get(identity)).toBe(
      winner
    )

    const discarded: Worktree = { ...rows[0], path: '/elsewhere', instanceId: 'instance-other' }
    useAppStore.setState({
      worktreesByRepo: { 'repo-17': [discarded, ...rows.slice(1), winner] }
    })
    const latest = useAppStore.getState().worktreesByRepo
    expect(getIndexedAllWorktrees(latest).find(({ id }) => id === winner.id)).toBe(winner)
    expect(getLineageAncestorIndex(latest).get(identity)?.path).toBe('/work/w0')
  })

  it('keeps the current copy in the lineage index when only a discarded copy is retitled', () => {
    const old: Worktree = { ...row(19, 0, false, () => {}), instanceId: 'instance-old' }
    const current: Worktree = { ...old, instanceId: 'instance-current' }
    const child = row(19, 1, false, () => {})
    useAppStore.setState({
      worktreesByRepo: { 'repo-19': [old, current, child] },
      detectedWorktreesByRepo: {}
    })
    const identity = getWorktreeHostIdentity(current)
    getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)

    useAppStore.setState({
      worktreesByRepo: { 'repo-19': [{ ...old, displayName: 'Old renamed' }, current, child] }
    })
    const index = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    expect(index.get(identity)?.instanceId).toBe('instance-current')
    const lineageById: Record<string, WorktreeLineage> = {
      [child.id]: {
        worktreeId: child.id,
        worktreeInstanceId: 'instance-19-1',
        parentWorktreeId: current.id,
        parentWorktreeInstanceId: 'instance-current',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    }
    expect(
      getSidebarLineageParentsByIdentity(lineageById, index).get(getWorktreeHostIdentity(child))
        ?.instanceId
    ).toBe('instance-current')
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

  it.each([750, 7500])(
    'a title pin reuses the hidden-project ancestor map among %i rows',
    (size) => {
      const rows = Array.from({ length: size - 1 }, (_, index) =>
        row(size + 3, index, false, () => {})
      )
      const repoId = `repo-${size + 3}`
      const hiddenRow: Worktree = {
        ...row(size + 3, size, false, () => {}),
        id: 'repo-hidden::/work/h',
        repoId: 'repo-hidden',
        path: '/work/h'
      }
      const hiddenRepo: Repo = { ...repo('repo-hidden'), hiddenAt: 1 }
      useAppStore.setState({
        repos: [repo(repoId), hiddenRepo],
        worktreesByRepo: { [repoId]: rows, 'repo-hidden': [hiddenRow] },
        detectedWorktreesByRepo: {},
        folderWorkspaces: [],
        crossStoreLineageByStoreKey: {},
        workspaceLineageByChildKey: {},
        worktreeLineageById: {}
      })
      const repoMap = new Map([
        [repoId, repo(repoId)],
        ['repo-hidden', hiddenRepo]
      ])
      const visible = (): Worktree[] =>
        computeVisibleWorktrees(useAppStore.getState().worktreesByRepo, [], {
          ...buildVisibleWorktreeOptionsFromState(useAppStore.getState(), repoMap),
          showSleepingWorkspaces: true
        })
      expect(visible().some(({ id }) => id === hiddenRow.id)).toBe(false)
      const ancestorWalks = countIterations(
        getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
      )

      applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
      const shown = visible()
      expect(shown.find(({ id }) => id === rows[0].id)?.displayName).toBe(TITLE)
      expect(shown.some(({ id }) => id === hiddenRow.id)).toBe(false)
      expect(ancestorWalks()).toBe(0)
    }
  )
})
