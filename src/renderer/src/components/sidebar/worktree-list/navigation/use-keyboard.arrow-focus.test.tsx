// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  endWorktreeListKeyboardNavigation,
  isWorktreeListKeyboardNavigationActive
} from '@/lib/worktree-list-keyboard-navigation'

const focusActiveWorkspaceTerminal = vi.hoisted(() => vi.fn())

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('./focus-active-workspace-terminal', () => ({ focusActiveWorkspaceTerminal }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: { keybindings: undefined }) => unknown) =>
    selector({ keybindings: undefined })
}))

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
  count: 0,
  getScrollElement: () => null,
  estimateSize: () => 0,
  scrollToFn: () => {},
  observeElementRect: () => {},
  observeElementOffset: () => {}
})

let container: HTMLDivElement
let root: Root

function renderList(): { list: HTMLDivElement; child: HTMLButtonElement } {
  function Probe(): React.JSX.Element {
    const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
      rows: [],
      renderRows: [],
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      pinnedDisplayPolicy: 'single-location',
      virtualizer,
      scrollRef: { current: null },
      activeModal: 'none',
      markDirectScrollInput: () => {}
    })
    return (
      <div data-testid="list" tabIndex={0} onKeyDown={handleContainerKeyDown}>
        <button type="button">card action</button>
      </div>
    )
  }
  act(() => root.render(<Probe />))
  const list = container.querySelector<HTMLDivElement>('[data-testid="list"]')
  const child = container.querySelector('button')
  if (!list || !child) {
    throw new Error('probe did not render')
  }
  return { list, child }
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })
    )
  })
}

beforeEach(() => {
  focusActiveWorkspaceTerminal.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  endWorktreeListKeyboardNavigation()
  act(() => root.unmount())
  container.remove()
})

describe('arrow keys in the focused workspace list', () => {
  it.each(['ArrowDown', 'ArrowUp'])('%s keeps the list as the focus owner', (key) => {
    const { list } = renderList()
    list.focus()

    press(list, key)

    expect(isWorktreeListKeyboardNavigationActive()).toBe(true)
  })

  it("hands focus to the active workspace's terminal on Enter", () => {
    const { list } = renderList()
    list.focus()

    press(list, 'Enter')

    expect(focusActiveWorkspaceTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not claim focus for arrows pressed on a control inside a card', () => {
    const { list, child } = renderList()
    list.focus()

    press(child, 'ArrowDown')

    expect(isWorktreeListKeyboardNavigationActive()).toBe(false)
  })
})
