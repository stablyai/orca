// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderRow } from '../listing/render-row'
import { getWorktreeOptionId } from '../rows/option-dom'
import { usePendingSidebarReveal } from './use-pending-reveal'
import type { PendingSidebarRevealArgs } from './pending-reveal-inputs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  setRenamingWorktreeId: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#737373',
  addedAt: 1
}

function worktree(id: string, isPinned = false): Worktree {
  return {
    id,
    repoId: repo.id,
    path: `/repo-1/${id}`,
    displayName: id,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

// Mirrors the duplicate-in-groups render order: the Pinned section rows come
// first, the ordinary group copy renders far below.
const wt1 = worktree('wt-1', true)
const other = worktree('wt-2')
const renderRows: RenderRow[] = [
  {
    type: 'item',
    rowKey: 'pinned:wt-1',
    sectionKey: 'pinned',
    worktree: wt1,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  },
  {
    type: 'item',
    rowKey: 'repo-1:wt-2',
    sectionKey: 'repo-1',
    worktree: other,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  },
  {
    type: 'item',
    rowKey: 'repo-1:wt-1',
    sectionKey: 'repo-1',
    worktree: wt1,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
]

const VIEWPORT_HEIGHT = 600

let root: Root
let rootContainer: HTMLElement
let container: HTMLDivElement
let scrollTo: ReturnType<typeof vi.fn>
let virtualizerScrollToIndex: ReturnType<typeof vi.fn>

function mountRowElement(rowKey: string, top: number, bottom: number): void {
  const element = document.createElement('div')
  element.id = getWorktreeOptionId(rowKey)
  element.getBoundingClientRect = () => ({ top, bottom }) as DOMRect
  container.append(element)
}

function makeArgs(overrides?: Partial<PendingSidebarRevealArgs>): PendingSidebarRevealArgs {
  return {
    pendingRevealWorktree: { worktreeId: 'wt-1', behavior: 'smooth' },
    pendingRevealSidebarRow: null,
    clearPendingRevealWorktreeId: vi.fn(),
    clearPendingRevealSidebarRow: vi.fn(),
    // Mirrors the focus-event path: the activated workspace is already the send
    // target, so the reveal needs no group expansion before row selection.
    agentSendTargetWorktreeId: 'wt-1',
    renderRows,
    virtualizer: { scrollToIndex: virtualizerScrollToIndex } as unknown as Virtualizer<
      HTMLDivElement,
      HTMLDivElement
    >,
    scrollRef: { current: container },
    worktrees: [wt1, other],
    folderWorkspaces: [],
    repoMap: new Map([[repo.id, repo]]),
    worktreeMap: new Map([
      [wt1.id, wt1],
      [other.id, other]
    ]),
    worktreeLineageById: {},
    collapsedGroups: new Set<string>(),
    toggleGroup: vi.fn(),
    groupBy: 'repo',
    pinnedDisplayPolicy: 'duplicate-in-groups',
    defaultHostId: 'local',
    prCache: null,
    workspaceStatuses: [],
    settings: {} as PendingSidebarRevealArgs['settings'],
    projectGroups: [],
    flashRevealedRow: vi.fn(),
    markRevealScroll: vi.fn(),
    schedulePendingRevealFrame: (callback) => callback(0),
    cancelPendingRevealFrames: vi.fn(),
    ...overrides
  }
}

async function runHook(args: PendingSidebarRevealArgs): Promise<void> {
  function Host(): null {
    usePendingSidebarReveal(args)
    return null
  }
  await act(async () => {
    root.render(<Host />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Why a separate React root: createRoot wipes its own container's children,
  // so the fake scroll container with the mounted rows must live elsewhere.
  container = document.createElement('div')
  Object.defineProperty(container, 'clientHeight', { value: VIEWPORT_HEIGHT })
  Object.defineProperty(container, 'scrollTop', { value: 0 })
  container.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT_HEIGHT }) as DOMRect
  scrollTo = vi.fn()
  container.scrollTo = scrollTo as unknown as typeof container.scrollTo
  document.body.append(container)
  // The pinned copy is on screen; the ordinary group copy sits below the fold.
  mountRowElement('pinned:wt-1', 100, 160)
  mountRowElement('repo-1:wt-2', 300, 360)
  mountRowElement('repo-1:wt-1', 1000, 1060)
  virtualizerScrollToIndex = vi.fn()
  rootContainer = document.createElement('div')
  document.body.append(rootContainer)
  root = createRoot(rootContainer)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  rootContainer.remove()
})

describe('a focus-driven reveal of a workspace whose pinned copy is on screen', () => {
  it('does not yank the viewport down to the ordinary group copy', async () => {
    await runHook(makeArgs())

    expect(scrollTo).not.toHaveBeenCalled()
    expect(virtualizerScrollToIndex).not.toHaveBeenCalled()
  })

  it('still scrolls when no copy of the workspace is visible', async () => {
    container.querySelector(`#${CSS.escape(getWorktreeOptionId('pinned:wt-1'))}`)?.remove()

    await runHook(makeArgs())

    expect(scrollTo).toHaveBeenCalled()
  })

  it('still scrolls under single-location rendering', async () => {
    const args = makeArgs({
      pinnedDisplayPolicy: 'single-location',
      renderRows: [renderRows[2]],
      worktreeMap: new Map([[wt1.id, wt1]])
    })

    await runHook(args)

    expect(scrollTo).toHaveBeenCalled()
  })
})
