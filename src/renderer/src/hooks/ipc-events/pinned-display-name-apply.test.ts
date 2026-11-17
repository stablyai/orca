// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeById,
  getIndexedWorktreeMap
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
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
    otherReads = 0
    resolvedNames.mockClear()

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    const pinned = useAppStore.getState().worktreesByRepo
    // Updated in place: 0 other catalog or lineage entries copied.
    expect(getIndexedWorktreeMap(pinned)).toBe(warmMap)
    expect(getIndexedAllWorktrees(pinned)).toBe(warmRows)
    expect(getLineageAncestorIndex(pinned)).toBe(warmLineage)
    expect(resolvedNames).toHaveBeenCalledTimes(0)
    expect(getIndexedWorktreeById(pinned, rows[0].id)).toMatchObject({
      displayName: TITLE,
      displayNameMode: 'fixed'
    })
    const lineageRows = [...getLineageAncestorIndex(pinned).values()]
    expect(lineageRows.find(({ id }) => id === rows[0].id)?.displayName).toBe(TITLE)
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
  })
})
