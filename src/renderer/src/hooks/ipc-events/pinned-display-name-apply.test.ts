// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import { renderHook } from '@testing-library/react'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeMap
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  useAllWorktrees,
  useWorktreeMap
} from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { subscribeStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { resolveStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type * as ChatTabName from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { getLineageAncestorIndex } from '@/components/sidebar/worktree-list/listing/visible-worktree-indexes'
import { applyLocalPinnedDisplayName } from './pinned-display-name-apply'

vi.mock('@/runtime/native-chat/naming/structured-chat-tab-name', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatTabName>()
  return { ...actual, resolveStructuredChatTabName: vi.fn(actual.resolveStructuredChatTabName) }
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
    lastActivityAt: 0
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
    useAppStore.setState({
      repos: [repo(repoId)],
      worktreesByRepo: { [repoId]: rows },
      detectedWorktreesByRepo: {},
      unifiedTabsByWorktree
    })
    const warmMap = getIndexedWorktreeMap(useAppStore.getState().worktreesByRepo)
    const warmRows = getIndexedAllWorktrees(useAppStore.getState().worktreesByRepo)
    const warmLineage = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
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
    const pinnedLineage = getLineageAncestorIndex(pinned)
    expect(pinnedMap).not.toBe(warmMap)
    expect(pinnedLineage).not.toBe(warmLineage)
    expect(pinnedMap.get(rows[0].id)).toMatchObject({
      displayName: TITLE,
      displayNameMode: 'fixed'
    })
    expect(pinnedLineage.get(getWorktreeHostIdentity(rows[0]))?.displayName).toBe(TITLE)
    expect(warmMap.get(rows[0].id)?.displayName).toBe('batfish-2')
    expect(mapCopies()).toBe(0)
    expect(lineageCopies()).toBe(0)
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
