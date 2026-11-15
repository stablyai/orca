// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { shouldPreserveEditableFocus } from '@/lib/text-input/focus/editable-focus-preservation'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'

const mocks = vi.hoisted(() => ({
  state: {
    keybindings: {},
    worktreeNavHistory: [],
    worktreeNavHistoryIndex: -1,
    activeWorktreeId: 'a',
    activeWorkspaceExecutionHostId: 'local',
    revealWorktreeInSidebar: () => {}
  },
  resolveDeleteIntent: vi.fn(() => null),
  focusActiveSurface: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn(async () => {})
}))
vi.mock('./focus-workspace-surface', () => ({
  focusActiveWorkspaceSurfaceFromSidebar: mocks.focusActiveSurface
}))
vi.mock('./use-neighbor-prewarm', () => ({ useWorkspaceNeighborPrewarm: () => {} }))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))

import { useSidebarWorktreeSelection } from './use-selection'
import { useWorktreeListKeyboardNavigation } from './use-keyboard'

const a: Worktree = { ...worktree, id: 'a', instanceId: 'inc-a', hostId: 'local' }
const b: Worktree = { ...worktree, id: 'b', instanceId: 'inc-b', hostId: 'local' }
const rows = [a, b].map((item): HostSectionRow => ({
  type: 'item',
  rowKey: item.id,
  sectionKey: 'all',
  worktree: item,
  repo,
  depth: 0,
  groupDepth: 0,
  isLastLineageChild: false,
  lineageChildCount: 0
}))

function Sidebar() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location'
  })
  const keyboard = useWorktreeListKeyboardNavigation({
    rows,
    activeWorktreeId: 'a',
    activeWorkspaceExecutionHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    scrollRef,
    activeModal: 'none',
    markDirectScrollInput: () => {},
    onKeyboardSelect: selection.selectWorktree,
    focusedWorktree: selection.focusedWorktree,
    resolveDeleteIntent: mocks.resolveDeleteIntent
  })
  return (
    <div data-worktree-sidebar-container>
      <div
        ref={scrollRef}
        data-worktree-sidebar
        tabIndex={0}
        onKeyDown={keyboard.handleContainerKeyDown}
      >
        {[a, b].map((item) => (
          <div
            key={item.id}
            role="option"
            aria-selected={selection.selectedWorktrees.includes(item)}
            data-testid={`row-${item.id}`}
            onClick={(event) => selection.updateSelectionForGesture(event, item)}
          >
            {/* Agent rows stop propagation, so they never reach the selection gesture. */}
            <div data-testid={`agent-${item.id}`} onClick={(event) => event.stopPropagation()} />
          </div>
        ))}
      </div>
      <textarea className="xterm-helper-textarea" data-testid="terminal" />
    </div>
  )
}

function list(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
}

// Mirrors a mouse press: the window capture listener runs, the tabIndex list takes native focus, then click.
function press(target: HTMLElement, modifiers: { ctrlKey?: boolean } = {}): void {
  fireEvent.pointerDown(target)
  list().focus()
  fireEvent.click(target, modifiers)
}

// The terminal mount/activation focus path yields to the list only while this is true.
function listOwnsKeys(): boolean {
  return shouldPreserveEditableFocus(document.activeElement)
}

beforeEach(() => {
  mocks.resolveDeleteIntent.mockClear()
  mocks.focusActiveSurface.mockClear()
})
afterEach(cleanup)

it('lets a plain row click hand keys to the opened workspace', () => {
  const view = render(<Sidebar />)
  press(view.getByTestId('row-b'))
  expect(listOwnsKeys()).toBe(false)
})

it('hands keys to the open workspace when its own row is clicked again', () => {
  const view = render(<Sidebar />)
  press(view.getByTestId('row-b'))
  expect(mocks.focusActiveSurface).not.toHaveBeenCalled()
  press(view.getByTestId('row-a'))
  expect(mocks.focusActiveSurface).toHaveBeenCalledWith(list())
})

it('keeps keys in the list for a modifier click', () => {
  const view = render(<Sidebar />)
  press(view.getByTestId('row-b'), { ctrlKey: true })
  expect(document.activeElement).toBe(list())
  expect(listOwnsKeys()).toBe(true)
})

it('releases the list after a modifier click once a plain click follows', () => {
  const view = render(<Sidebar />)
  press(view.getByTestId('row-b'), { ctrlKey: true })
  press(view.getByTestId('row-a'))
  expect(listOwnsKeys()).toBe(false)
})

it('releases the list after arrow navigation once a row is clicked', () => {
  const view = render(<Sidebar />)
  list().focus()
  fireEvent.keyDown(list(), { key: 'ArrowDown' })
  expect(listOwnsKeys()).toBe(true)
  press(view.getByTestId('row-a'))
  expect(listOwnsKeys()).toBe(false)
})

it('releases the list when an agent row is clicked', () => {
  const view = render(<Sidebar />)
  press(view.getByTestId('row-b'), { ctrlKey: true })
  press(view.getByTestId('agent-a'))
  expect(listOwnsKeys()).toBe(false)
})

it('runs the delete shortcut only while the list has focus', () => {
  const view = render(<Sidebar />)
  const deleteKey = { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true }
  view.getByTestId('terminal').focus()
  fireEvent.keyDown(view.getByTestId('terminal'), deleteKey)
  expect(mocks.resolveDeleteIntent).not.toHaveBeenCalled()

  press(view.getByTestId('row-b'), { ctrlKey: true })
  fireEvent.keyDown(list(), deleteKey)
  expect(mocks.resolveDeleteIntent).toHaveBeenCalledTimes(1)
})
