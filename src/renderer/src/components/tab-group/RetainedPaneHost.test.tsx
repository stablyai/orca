// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RetainedPaneHost } from './RetainedPaneHost'
import { registerTabGroupBody } from './tab-group-body-geometry'

const disconnect = vi.fn()
const observerCreated = vi.fn()
let notifyResize: () => void
let anchors: HTMLDivElement[]
let unregisterAnchors: (() => void)[]

beforeEach(() => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notifyResize = callback
        observerCreated()
      }
      observe(): void {}
      unobserve(): void {}
      disconnect = disconnect
    }
  )
  disconnect.mockClear()
  observerCreated.mockClear()
  anchors = ['left', 'right'].map((id, index) => {
    const anchor = document.createElement('div')
    anchor.dataset.tabGroupBodyId = id
    anchor.getBoundingClientRect = () => new DOMRect(index * 400, 32, 400, 568)
    document.body.append(anchor)
    return anchor
  })
  unregisterAnchors = ['left', 'right'].map((id, index) => registerTabGroupBody(id, anchors[index]))
})

afterEach(() => {
  cleanup()
  unregisterAnchors.forEach((unregister) => unregister())
  anchors.forEach((anchor) => anchor.remove())
  vi.restoreAllMocks()
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

function countResizeListeners(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([type]) => type === 'resize').length
}

it('measures a group once for all of its visible panes', () => {
  const addListener = vi.spyOn(window, 'addEventListener')
  const view = render(
    <>
      <RetainedPaneHost groupId="left" isVisible>
        <span />
      </RetainedPaneHost>
      <RetainedPaneHost groupId="left" isVisible>
        <span />
      </RetainedPaneHost>
      <RetainedPaneHost groupId="left" isVisible>
        <span />
      </RetainedPaneHost>
    </>
  )
  expect(observerCreated).toHaveBeenCalledTimes(1)
  expect(countResizeListeners(addListener)).toBe(1)

  const measureBody = vi.fn(() => new DOMRect(0, 40, 300, 500))
  anchors[0].getBoundingClientRect = measureBody
  act(() => notifyResize())
  expect(measureBody).toHaveBeenCalledTimes(1)
  const hosts = Array.from(
    view.container.querySelectorAll<HTMLElement>('[data-retained-pane-host]')
  )
  expect(hosts.map((host) => host.style.width)).toEqual(['300px', '300px', '300px'])

  const removeListener = vi.spyOn(window, 'removeEventListener')
  view.unmount()
  expect(disconnect).toHaveBeenCalledTimes(1)
  expect(countResizeListeners(removeListener)).toBe(1)
})

it('does not measure a hidden pane until it becomes visible', () => {
  const addListener = vi.spyOn(window, 'addEventListener')
  const view = render(
    <RetainedPaneHost groupId="left" isVisible={false}>
      <span />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  expect(observerCreated).not.toHaveBeenCalled()
  expect(countResizeListeners(addListener)).toBe(0)
  expect(host.style.display).toBe('none')

  anchors[0].getBoundingClientRect = () => new DOMRect(0, 48, 320, 400)
  view.rerender(
    <RetainedPaneHost groupId="left" isVisible>
      <span />
    </RetainedPaneHost>
  )
  expect(observerCreated).toHaveBeenCalledTimes(1)
  expect(host.style.top).toBe('48px')
  expect(host.style.width).toBe('320px')

  view.rerender(
    <RetainedPaneHost groupId="left" isVisible={false}>
      <span />
    </RetainedPaneHost>
  )
  expect(disconnect).toHaveBeenCalledTimes(1)
})

it('keeps measuring a hidden pane that asks to measure while hidden', () => {
  const view = render(
    <RetainedPaneHost groupId="left" isVisible={false} measureWhileHidden>
      <span />
    </RetainedPaneHost>
  )
  const host = view.container.firstElementChild as HTMLDivElement
  expect(observerCreated).toHaveBeenCalledTimes(1)
  expect(host.style.width).toBe('400px')
  anchors[0].getBoundingClientRect = () => new DOMRect(0, 32, 360, 568)
  act(() => notifyResize())
  expect(host.style.width).toBe('360px')
})
