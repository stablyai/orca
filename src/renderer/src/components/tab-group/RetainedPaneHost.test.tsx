// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RetainedPaneHost } from './RetainedPaneHost'

const disconnect = vi.fn()
let notifyResize: () => void
let anchors: HTMLDivElement[]

beforeEach(() => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe(): void {}
      disconnect = disconnect
    }
  )
  disconnect.mockClear()
  anchors = ['left', 'right'].map((id, index) => {
    const anchor = document.createElement('div')
    anchor.dataset.tabGroupBodyId = id
    anchor.getBoundingClientRect = () => new DOMRect(index * 400, 32, 400, 568)
    document.body.append(anchor)
    return anchor
  })
})

afterEach(() => {
  cleanup()
  anchors.forEach((anchor) => anchor.remove())
  vi.unstubAllGlobals()
})

it('retains pane content across group moves and visibility changes using measured browser bounds', () => {
  const focus = vi.fn()
  const content = <input defaultValue="draft" />
  const view = render(
    <RetainedPaneHost groupId="left" isVisible onFocusOwningGroup={focus}>
      {content}
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  const input = view.getByRole('textbox')
  expect(host.style.top).toBe('32px')
  expect(host.style.width).toBe('400px')
  fireEvent.change(input, { target: { value: 'unsent draft' } })

  view.rerender(
    <RetainedPaneHost groupId="right" isVisible onFocusOwningGroup={focus}>
      {content}
    </RetainedPaneHost>
  )
  expect(host.style.left).toBe('400px')
  expect(view.getByRole('textbox')).toBe(input)
  expect((input as HTMLInputElement).value).toBe('unsent draft')
  fireEvent.pointerDown(input)
  expect(focus).toHaveBeenLastCalledWith('right')

  anchors[1].getBoundingClientRect = () => new DOMRect(450, 32, 350, 500)
  act(() => notifyResize())
  expect(host.style.left).toBe('450px')
  expect(host.style.width).toBe('350px')

  view.rerender(
    <RetainedPaneHost groupId="right" isVisible={false}>
      {content}
    </RetainedPaneHost>
  )
  expect(host.style.display).toBe('none')
  expect(host.hasAttribute('inert')).toBe(true)
  expect(host.contains(input)).toBe(true)
  view.rerender(
    <RetainedPaneHost groupId="right" isVisible>
      {content}
    </RetainedPaneHost>
  )
  expect(host.style.display).toBe('flex')
  expect(host.hasAttribute('inert')).toBe(false)
  expect(view.getByRole('textbox')).toBe(input)
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})

it('allows hidden terminal startup measurement without exposing input or starting fit timers for chat', () => {
  const timeout = vi.spyOn(window, 'setTimeout')
  const view = render(
    <RetainedPaneHost groupId="left" isVisible={false} measureWhileHidden>
      <input />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  expect(host.style.display).toBe('flex')
  expect(host.style.opacity).toBe('0')
  expect(host.style.pointerEvents).toBe('none')
  expect(host.hasAttribute('inert')).toBe(true)
  view.rerender(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  expect(timeout).not.toHaveBeenCalled()
  timeout.mockRestore()
})

it('attaches no scroll listener at all when the pane has no agent-cards ancestor (I4)', () => {
  const documentAddSpy = vi.spyOn(document, 'addEventListener')
  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  expect(documentAddSpy).not.toHaveBeenCalledWith('scroll', expect.anything(), true)
  view.unmount()
  documentAddSpy.mockRestore()
})

it('leaves a pane with no agent-cards ancestor unclipped', () => {
  anchors[0].getBoundingClientRect = () => new DOMRect(0, -400, 400, 568)
  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  act(() => notifyResize())
  expect(host.style.clipPath).toBe('')
  view.unmount()
})

it('scopes the fallback scroll listener to the agent-cards ancestor, not document (I4)', () => {
  const grid = document.createElement('div')
  grid.dataset.orcaAgentCards = 'wt-1'
  anchors[0].remove()
  grid.append(anchors[0])
  document.body.append(grid)
  const gridAddSpy = vi.spyOn(grid, 'addEventListener')
  const gridRemoveSpy = vi.spyOn(grid, 'removeEventListener')

  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  expect(gridAddSpy).toHaveBeenCalledWith('scroll', expect.any(Function))
  // Why not capture: the grid is the scroll target, and capture would re-measure every mounted
  // host whenever a scroll happened inside any one terminal or chat (A5).
  expect(gridAddSpy).not.toHaveBeenCalledWith('scroll', expect.anything(), true)

  anchors[0].getBoundingClientRect = () => new DOMRect(10, 10, 400, 568)
  act(() => fireEvent.scroll(grid))
  const host = view.container.firstElementChild as HTMLDivElement
  expect(host.style.left).toBe('10px')

  view.unmount()
  expect(gridRemoveSpy).toHaveBeenCalledWith('scroll', expect.any(Function))
  expect(gridRemoveSpy).not.toHaveBeenCalledWith('scroll', expect.anything(), true)
  grid.remove()
})

function mountCardGrid(): HTMLDivElement {
  const grid = document.createElement('div')
  grid.dataset.orcaAgentCards = 'wt-1'
  grid.getBoundingClientRect = () => new DOMRect(0, 100, 400, 200)
  grid.append(anchors[0])
  document.body.append(grid)
  // The card body straddles the grid: it starts above the scroll viewport and ends below it.
  anchors[0].getBoundingClientRect = () => new DOMRect(0, 40, 400, 400)
  return grid
}

it('clips a half-scrolled card pane to the agent-cards viewport instead of painting past it', () => {
  const grid = mountCardGrid()
  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  // Why a stale host rect is harmless: the clip is measured from the anchor body, because
  // Chromium applies the anchor scroll offset a frame late to the pane's own rect.
  host.getBoundingClientRect = () => new DOMRect(0, 120, 400, 100)
  act(() => fireEvent.scroll(grid))
  expect(host.style.clipPath).toBe('inset(60px 0px 140px 0px)')

  grid.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600)
  act(() => fireEvent.scroll(grid))
  expect(host.style.clipPath).toBe('')

  view.unmount()
  grid.remove()
})

it('installs the clip when the card grid commits a frame after the pane', async () => {
  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  expect(host.style.clipPath).toBe('')

  // The card body and its grid land in a later commit than the pane, so the first effect run
  // found no anchor at all and only the one-frame retry can install the clip.
  const grid = mountCardGrid()
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null))
    })
  })
  host.getBoundingClientRect = () => new DOMRect(0, 120, 400, 100)
  act(() => fireEvent.scroll(grid))
  expect(host.style.clipPath).toBe('inset(60px 0px 140px 0px)')

  view.unmount()
  grid.remove()
})

it('drops the clip when the pane leaves the card grid for an ordinary split group', () => {
  const grid = mountCardGrid()
  const view = render(
    <RetainedPaneHost groupId="left" isVisible>
      <input />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  act(() => fireEvent.scroll(grid))
  expect(host.style.clipPath).toBe('inset(60px 0px 140px 0px)')

  view.rerender(
    <RetainedPaneHost groupId="right" isVisible>
      <input />
    </RetainedPaneHost>
  )
  expect(host.style.clipPath).toBe('')

  view.unmount()
  grid.remove()
})
