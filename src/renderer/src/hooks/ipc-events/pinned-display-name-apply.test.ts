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
})
