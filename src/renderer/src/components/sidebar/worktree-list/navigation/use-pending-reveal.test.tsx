// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { makeRepo, makeWorktree } from '../listing/worktree-list-lineage-card-test-fixtures'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getWorktreeOptionId } from '../rows/option-dom'
import { usePendingSidebarReveal } from './use-pending-reveal'

const VIEWPORT_HEIGHT = 600
const repo = makeRepo()
const pinned = {
  ...makeWorktree({
    id: 'wt-1',
    displayName: 'One',
    branch: 'one',
    sortOrder: 0,
    instanceId: 'i1'
  }),
  hostId: 'local' as const,
  isPinned: true
}

function itemRow(rowKey: string, sectionKey: string): WorktreeItemRow {
  return {
    type: 'item',
    rowKey,
    sectionKey,
    worktree: pinned,
    repo,
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const renderRows = [itemRow('pinned:wt-1', PINNED_GROUP_KEY), itemRow('repo-1:wt-1', 'repo-1')]
const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
  count: renderRows.length,
  getScrollElement: () => null,
  estimateSize: () => 40,
  scrollToFn: vi.fn(),
  observeElementRect: vi.fn(),
  observeElementOffset: vi.fn()
})
const container = document.createElement('div')
const scrollTo = vi.fn()

function mountOption(
  rowKey: string,
  top: number,
  lineageChildrenTop?: number,
  lineageChildrenHeight = 300
): void {
  const option = document.createElement('div')
  option.id = getWorktreeOptionId(rowKey)
  option.dataset.worktreeId = pinned.id
  option.dataset.worktreeHostIdentity = getWorktreeHostIdentity(pinned)
  option.dataset.worktreeRowKey = rowKey
  option.getBoundingClientRect = () => DOMRect.fromRect({ y: top, height: 60, width: 200 })
  const surface = document.createElement('div')
  surface.dataset.worktreeCardSurface = 'true'
  option.append(surface)
  if (lineageChildrenTop !== undefined) {
    const children = document.createElement('div')
    children.dataset.worktreeLineageChildren = ''
    children.getBoundingClientRect = () =>
      DOMRect.fromRect({ y: lineageChildrenTop, height: lineageChildrenHeight, width: 200 })
    surface.append(children)
    option.getBoundingClientRect = () =>
      DOMRect.fromRect({
        y: top,
        height: lineageChildrenTop + lineageChildrenHeight - top,
        width: 200
      })
  }
  container.append(option)
}

function reveal(executionHostId?: 'local'): ReturnType<typeof vi.fn> {
  const flashRevealedRow = vi.fn()
  const pendingRevealWorktree = {
    worktreeId: pinned.id,
    executionHostId,
    behavior: 'auto' as const,
    highlight: true
  }
  useAppStore.setState({ pendingRevealWorktree })
  renderHook(() =>
    usePendingSidebarReveal({
      pendingRevealWorktree,
      pendingRevealSidebarRow: null,
      clearPendingRevealWorktreeId: vi.fn(),
      clearPendingRevealSidebarRow: vi.fn(),
      agentSendTargetWorktreeId: pinned.id,
      renderRows,
      virtualizer,
      scrollRef: { current: container },
      worktrees: [pinned],
      folderWorkspaces: [],
      repoMap: new Map([[repo.id, repo]]),
      worktreeMap: new Map([[pinned.id, pinned]]),
      worktreeLineageById: {},
      collapsedGroups: new Set(),
      toggleGroup: vi.fn(),
      groupBy: 'repo',
      pinnedDisplayPolicy: 'duplicate-in-groups',
      defaultHostId: 'local',
      prCache: null,
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      settings: useAppStore.getState().settings,
      projectGroups: [],
      flashRevealedRow,
      markRevealScroll: vi.fn(),
      schedulePendingRevealFrame: (callback) => callback(0),
      cancelPendingRevealFrames: vi.fn()
    })
  )
  return flashRevealedRow
}

beforeEach(() => {
  container.replaceChildren()
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  container.scrollTop = 0
  container.getBoundingClientRect = () => DOMRect.fromRect({ height: VIEWPORT_HEIGHT, width: 200 })
  container.scrollTo = scrollTo
  scrollTo.mockClear()
  document.body.append(container)
})
afterEach(cleanup)

describe('pending worktree reveal with a pinned duplicate (#24852)', () => {
  it('keeps the viewport on an on-screen pinned copy instead of scrolling to the group copy', () => {
    mountOption('pinned:wt-1', 100)
    mountOption('repo-1:wt-1', 1000)

    const flashRevealedRow = reveal()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(flashRevealedRow).toHaveBeenCalledWith('pinned:wt-1')
  })

  it('keeps the lookup-preferred group copy when both copies are fully visible', () => {
    mountOption('pinned:wt-1', 100)
    mountOption('repo-1:wt-1', 300)

    const flashRevealedRow = reveal('local')

    expect(scrollTo).not.toHaveBeenCalled()
    expect(flashRevealedRow).toHaveBeenCalledWith('repo-1:wt-1')
  })

  it('does not scroll a visible parent card away to fit its overflowing lineage children', () => {
    mountOption('pinned:wt-1', 100, 160, 1000)
    mountOption('repo-1:wt-1', 2000)

    const flashRevealedRow = reveal('local')

    expect(scrollTo).not.toHaveBeenCalled()
    expect(flashRevealedRow).toHaveBeenCalledWith('pinned:wt-1')
  })

  it('prefers a fully visible group copy over a pinned copy clipped under the sticky header', () => {
    mountOption('pinned:wt-1', 10)
    mountOption('repo-1:wt-1', 300)

    const flashRevealedRow = reveal('local')

    expect(scrollTo).not.toHaveBeenCalled()
    expect(flashRevealedRow).toHaveBeenCalledWith('repo-1:wt-1')
  })

  it('ignores visible lineage children when the pinned parent card itself is off-screen', () => {
    mountOption('pinned:wt-1', -200, 100)
    mountOption('repo-1:wt-1', 500)

    const flashRevealedRow = reveal('local')

    expect(scrollTo).not.toHaveBeenCalled()
    expect(flashRevealedRow).toHaveBeenCalledWith('repo-1:wt-1')
  })

  it('nudges a clipped pinned copy into view rather than jumping to the group copy', () => {
    mountOption('pinned:wt-1', 570)
    mountOption('repo-1:wt-1', 1000)

    reveal('local')

    expect(scrollTo).toHaveBeenCalledWith({ top: 30, behavior: 'auto' })
  })

  it('still prefers the group copy when no copy is on screen', () => {
    mountOption('pinned:wt-1', -200)
    mountOption('repo-1:wt-1', 1000)

    reveal('local')

    expect(scrollTo).toHaveBeenCalledWith({ top: 460, behavior: 'auto' })
  })
})
