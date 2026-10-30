// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeNavHistoryEntry } from '@/store/slices/worktree-nav-history'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

const activateAndRevealWorktree = vi.fn()

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activateAndRevealWorktree(...args)
}))

const state: {
  keybindings: undefined
  worktreeNavHistory: WorktreeNavHistoryEntry[]
  worktreeNavHistoryIndex: number
} = { keybindings: undefined, worktreeNavHistory: [], worktreeNavHistoryIndex: -1 }
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Local worktrees carry no `hostId` — `withRepoHostOwnership` leaves them unqualified.
function localRow(id: string, hostId?: ExecutionHostId): HostSectionRow & { type: 'item' } {
  return {
    type: 'item',
    rowKey: `row:${hostId ?? 'local'}:${id}`,
    sectionKey: 'repo:repo-1',
    worktree: { ...worktree, id, ...(hostId ? { hostId } : {}) },
    repo,
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

let rows: HostSectionRow[]

let container: HTMLDivElement
let root: Root

function press(direction: 'up' | 'down'): void {
  const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        code: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...mod
      })
    )
  })
}

function Probe({
  activeWorktreeId,
  activeHostId
}: {
  activeWorktreeId: string | null
  activeHostId: ExecutionHostId | null
}): null {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30
  })
  useWorktreeListKeyboardNavigation({
    rows,
    renderRows: rows,
    activeWorktreeId,
    activeWorkspaceExecutionHostId: activeHostId,
    pinnedDisplayPolicy: 'single-location',
    virtualizer,
    scrollRef,
    activeModal: 'none',
    markDirectScrollInput: () => {}
  })
  return null
}

function renderProbe(activeWorktreeId: string | null, activeHostId: ExecutionHostId | null): void {
  act(() => root.render(<Probe activeWorktreeId={activeWorktreeId} activeHostId={activeHostId} />))
}

beforeEach(() => {
  activateAndRevealWorktree.mockClear()
  rows = [localRow('a'), localRow('b'), localRow('c')]
  state.worktreeNavHistory = []
  state.worktreeNavHistoryIndex = -1
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('worktree keyboard cycling with a resolved active host', () => {
  it('steps to the next row when the active host resolved to local but rows are unqualified', () => {
    // Clicks resolve local host ownership; raw hostless identities would miss the active row and wrap to the top.
    renderProbe('b', 'local')

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('steps to the previous row when the active host resolved to local', () => {
    renderProbe('b', 'local')

    press('up')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('a', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('still steps normally when the active host is unqualified', () => {
    renderProbe('b', null)

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })
})

describe('workspace keyboard cycling after closing the final tab', () => {
  it.each([
    ['down', 'c'],
    ['up', 'a']
  ] as const)('continues %s from the history cursor', (direction, expected) => {
    state.worktreeNavHistory = ['a', 'b']
    state.worktreeNavHistoryIndex = 1
    renderProbe('b', 'local')
    renderProbe(null, null)

    press(direction)

    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith(expected, {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('keeps the host of the just-closed workspace when ids repeat across hosts', () => {
    rows = [localRow('b'), localRow('a'), localRow('b', 'ssh:other'), localRow('c', 'ssh:other')]
    state.worktreeNavHistory = ['b']
    state.worktreeNavHistoryIndex = 0
    renderProbe('b', 'ssh:other')
    renderProbe(null, null)

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false,
      executionHostId: 'ssh:other'
    })
  })

  it('skips pages and unavailable rows without reading forward history', () => {
    state.worktreeNavHistory = ['b', 'deleted-workspace', 'skills', 'tasks', 'c']
    state.worktreeNavHistoryIndex = 3
    renderProbe(null, null)

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('keeps a collapsed active selection ahead of a visible history anchor', () => {
    state.worktreeNavHistory = ['b']
    state.worktreeNavHistoryIndex = 0
    renderProbe('hidden', 'local')

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('a', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })
})
