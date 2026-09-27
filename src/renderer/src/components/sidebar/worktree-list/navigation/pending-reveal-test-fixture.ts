import { vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import type { PendingSidebarRevealArgs } from './pending-reveal-inputs'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeOptionId } from '../rows/option-dom'

export function pendingRevealFixture(kind: 'worktree' | 'row') {
  const worktree: Worktree = {
    id: 'target',
    repoId: 'repo',
    path: '/workspace/target',
    displayName: 'Target',
    branch: 'target',
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
  const container = document.createElement('div')
  const element = document.createElement('div')
  element.id = getWorktreeOptionId('target-row')
  element.dataset.worktreeRowKey = 'target-row'
  container.append(element)
  document.body.append(container)
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  Object.defineProperty(container, 'scrollHeight', { value: 20_000 })
  container.getBoundingClientRect = () => new DOMRect(0, 0, 200, 600)
  element.getBoundingClientRect = () => new DOMRect(0, 10_000 - container.scrollTop, 200, 100)
  const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && options.behavior !== 'smooth') {
      container.scrollTop = options.top ?? container.scrollTop
    }
  })
  container.scrollTo = scrollTo
  const frames: FrameRequestCallback[] = []
  const state = { settling: true, interrupted: false }
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 1,
    getScrollElement: () => container,
    estimateSize: () => 100,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn()
  })
  vi.spyOn(virtualizer, 'scrollToIndex').mockImplementation(() => {})
  const args: PendingSidebarRevealArgs = {
    pendingRevealWorktree:
      kind === 'worktree'
        ? { worktreeId: 'target', behavior: 'smooth', highlight: true, beginRename: true }
        : null,
    pendingRevealSidebarRow:
      kind === 'row' ? { rowKey: 'target-row', behavior: 'smooth', highlight: true } : null,
    clearPendingRevealWorktreeId: vi.fn(),
    clearPendingRevealSidebarRow: vi.fn(),
    agentSendTargetWorktreeId: 'target',
    renderRows: [
      {
        type: 'item',
        rowKey: 'target-row',
        sectionKey: 'all',
        worktree,
        repo: undefined,
        depth: 0,
        groupDepth: 0,
        lineageTrail: [],
        isLastLineageChild: true,
        lineageChildCount: 0
      }
    ],
    virtualizer,
    scrollRef: { current: container },
    worktrees: [worktree],
    folderWorkspaces: [],
    repoMap: new Map(),
    worktreeMap: new Map([['target', worktree]]),
    worktreeLineageById: {},
    collapsedGroups: new Set(),
    toggleGroup: vi.fn(),
    groupBy: 'none',
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: 'local',
    prCache: null,
    workspaceStatuses: [],
    settings: null,
    projectGroups: [],
    flashRevealedRow: vi.fn(),
    markRevealScroll: vi.fn(),
    isRevealScrollSettling: () => state.settling,
    wasRevealScrollInterrupted: () => state.interrupted,
    schedulePendingRevealFrame: (frame) => {
      frames.push(frame)
    }
  }
  return {
    args,
    container,
    element,
    frames,
    state,
    scrollTo,
    frame: () => {
      const batch = frames.splice(0)
      batch.forEach((frame) => frame(0))
    }
  }
}
