// @vitest-environment happy-dom

import { useLayoutEffect, useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, setSidebarBotsHeight: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import {
  SidebarBotsSplit,
  SidebarProjectsListSlot,
  holdSidebarBotsHeightForSearch
} from './SidebarBotsSplit'

// happy-dom has no layout; the split's section and the Projects list read these heights.
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
let sectionHeight = 0
let listHeight = 0
// The open search's floor (min-h-47): a held height below it renders at the floor.
const SEARCH_FLOOR = 188

/** Stands in for the open Bots search, which holds the section the way the real panel does. */
function OpenSearch(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => holdSidebarBotsHeightForSearch(ref.current!), [])
  return <div ref={ref} data-bot-sidebar-search="multiple-rows" />
}

function tree(projectsCollapsed = false, searching = false): React.JSX.Element {
  return (
    <div>
      <SidebarBotsSplit projectsCollapsed={projectsCollapsed}>
        <div data-testid="bots">{searching ? <OpenSearch /> : null}</div>
      </SidebarBotsSplit>
      <div data-testid="fixed-row" />
      <SidebarProjectsListSlot botsShown>
        <div />
      </SidebarProjectsListSlot>
    </div>
  )
}

function renderSplit(height: number, list: number, projectsCollapsed = false) {
  sectionHeight = height
  listHeight = list
  const view = render(tree(projectsCollapsed))
  return {
    ...view,
    section: view.getByTestId('bots').parentElement!,
    handle: view.container.querySelector('[data-sidebar-bots-resize-handle]')!
  }
}

function drag(handle: Element, fromY: number, toY: number): void {
  fireEvent.mouseDown(handle, { clientY: fromY })
  fireEvent.mouseMove(window, { clientY: toY })
  fireEvent.mouseUp(window, { clientY: toY })
}

describe('SidebarBotsSplit', () => {
  beforeEach(() => {
    mocks.setSidebarBotsHeight.mockReset()
    mocks.state = {
      sidebarBotsHeight: null,
      setSidebarBotsHeight: mocks.setSidebarBotsHeight,
      collapsedGroups: new Set<string>()
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.querySelector(':scope > [data-testid="bots"]')) {
          // A set height renders as that height, under the cap and above the search floor,
          // whatever the content.
          if (!this.style.height) {
            return sectionHeight
          }
          const cap = Number.parseFloat(this.style.maxHeight) || Infinity
          return Math.max(SEARCH_FLOOR, Math.min(cap, Number.parseFloat(this.style.height)))
        }
        return this.hasAttribute('data-sidebar-projects-list') ? listHeight : 0
      }
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
    }
  })

  it('saves the dragged height, starting from the rendered height', () => {
    const { handle } = renderSplit(200, 400)
    drag(handle, 300, 350)
    expect(mocks.setSidebarBotsHeight).toHaveBeenCalledWith(250)
  })

  it('limits a drag by the space free now, after a fixed row took some of it', () => {
    const { handle } = renderSplit(200, 400)
    // A banner appears: the list gives up 250px with no outer sidebar resize.
    listHeight = 150
    drag(handle, 300, 2000)
    expect(mocks.setSidebarBotsHeight).toHaveBeenCalledWith(230)
  })

  it('keeps a drag alive through a re-render that changes the saved height', () => {
    const { handle, rerender } = renderSplit(200, 400)
    fireEvent.mouseDown(handle, { clientY: 300 })
    mocks.state.sidebarBotsHeight = 320
    rerender(tree())
    fireEvent.mouseMove(window, { clientY: 260 })
    fireEvent.mouseUp(window, { clientY: 260 })
    expect(mocks.setSidebarBotsHeight).toHaveBeenCalledWith(160)
  })

  it('does not save on a press without movement, and double-click resets', () => {
    const { handle } = renderSplit(200, 400)
    drag(handle, 300, 300)
    expect(mocks.setSidebarBotsHeight).not.toHaveBeenCalled()
    fireEvent.mouseDown(handle, { clientY: 300, detail: 2 })
    expect(mocks.setSidebarBotsHeight).toHaveBeenCalledWith(null)
  })

  it('removes the resize handle and saved cap while Projects is folded', () => {
    mocks.state.sidebarBotsHeight = 300
    const { section, handle } = renderSplit(200, 400, true)
    expect(handle).toBeNull()
    expect(section.style.maxHeight).toBe('')
  })

  it('hides the Projects list without unmounting it while folded', () => {
    const view = render(
      <SidebarProjectsListSlot botsShown collapsed>
        <div data-testid="list" />
      </SidebarProjectsListSlot>
    )
    expect(view.getByTestId('list').parentElement!.className).toContain('hidden')
  })

  it('hides the handle while the Bots section is collapsed', () => {
    mocks.state.collapsedGroups = new Set([BOTS_GROUP_KEY])
    const { container } = renderSplit(40, 400)
    expect(container.querySelector('[data-sidebar-bots-resize-handle]')).toBeNull()
  })

  describe('while search is open', () => {
    /** Search opens in a section already on screen, as the header toggle does. */
    function renderSearching(height: number) {
      const view = renderSplit(height, 400)
      view.rerender(tree(false, true))
      return view
    }

    it('keeps the height it opened with as results change, and gives it back on close', () => {
      mocks.state.sidebarBotsHeight = 420
      const { section, rerender } = renderSearching(300)
      expect(section.offsetHeight).toBe(300)
      // Fewer results: the content shrinks, the section does not.
      sectionHeight = 200
      rerender(tree(false, true))
      expect(section.offsetHeight).toBe(300)
      rerender(tree(false, false))
      expect(section.offsetHeight).toBe(200)
      expect(section.style.maxHeight).toBe('420px')
    })

    it('keeps its height and the saved cap when the search floor masks a drag', () => {
      mocks.state.sidebarBotsHeight = 420
      const { section, handle } = renderSearching(SEARCH_FLOOR)
      drag(handle, 300, 200)
      expect(mocks.setSidebarBotsHeight).not.toHaveBeenCalled()
      expect(section.style.maxHeight).toBe('420px')
      sectionHeight = 100
      expect(section.offsetHeight).toBe(SEARCH_FLOOR)
    })

    it('comes back to the height it opened with when a drag returns to where it started', () => {
      mocks.state.sidebarBotsHeight = 420
      const { section, handle } = renderSearching(300)
      fireEvent.mouseDown(handle, { clientY: 300 })
      fireEvent.mouseMove(window, { clientY: 350 })
      expect(section.offsetHeight).toBe(350)
      fireEvent.mouseMove(window, { clientY: 300 })
      fireEvent.mouseUp(window, { clientY: 300 })
      sectionHeight = 120
      expect(section.offsetHeight).toBe(300)
      expect(section.style.maxHeight).toBe('420px')
      expect(mocks.setSidebarBotsHeight).not.toHaveBeenCalled()
    })

    it('grows with the keyboard when the step reaches the saved cap', () => {
      mocks.state.sidebarBotsHeight = SEARCH_FLOOR + 8
      const { section, handle } = renderSearching(SEARCH_FLOOR)
      fireEvent.keyDown(handle, { key: 'ArrowDown' })
      expect(section.offsetHeight).toBe(SEARCH_FLOOR + 8)
      expect(mocks.setSidebarBotsHeight).toHaveBeenLastCalledWith(SEARCH_FLOOR + 8)
    })

    it('grows with a drag that ends at the saved cap', () => {
      mocks.state.sidebarBotsHeight = 260
      const { section, handle } = renderSearching(SEARCH_FLOOR)
      drag(handle, 300, 300 + 260 - SEARCH_FLOOR)
      expect(section.offsetHeight).toBe(260)
      expect(mocks.setSidebarBotsHeight).toHaveBeenCalledWith(260)
    })

    it('keeps its height when a passive cap change arrives while searching', () => {
      mocks.state.sidebarBotsHeight = 420
      const { section, rerender } = renderSearching(300)
      mocks.state.sidebarBotsHeight = 500
      rerender(tree(false, true))
      sectionHeight = 120
      expect(section.offsetHeight).toBe(300)
    })
  })
})
