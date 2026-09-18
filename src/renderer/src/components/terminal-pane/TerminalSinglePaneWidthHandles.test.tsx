// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSinglePaneWidthHandles } from './TerminalSinglePaneWidthHandles'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function renderHandles(onCommit = vi.fn()) {
  // The handles only mount inside a retained pane host, matching the CSS cap's scope.
  const host = document.createElement('div')
  host.setAttribute('data-retained-pane-host', '')
  const container = document.createElement('div')
  container.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 800)
  host.append(container)
  document.body.append(host)
  const ref = createRef<HTMLDivElement>()
  ref.current = container
  const view = render(
    <TerminalSinglePaneWidthHandles
      containerRef={ref}
      maxWidth={1000}
      dividerStyle={{}}
      onCommit={onCommit}
    />
  )
  const [left, right] = screen.getAllByRole('separator')
  return { container, left, right, onCommit, unmount: view.unmount }
}

// happy-dom has no pointer capture; the component calls it on the handle itself.
const stubCapture = (el: HTMLElement): void => {
  el.setPointerCapture = () => {}
  el.releasePointerCapture = () => {}
}

const drag = (handle: HTMLElement, from: number, to: number): void => {
  stubCapture(handle)
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: from })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: to })
}

describe('TerminalSinglePaneWidthHandles', () => {
  it('sits on both edges of the centered pane', () => {
    const { left, right } = renderHandles()
    // 1600 wide tab, 1000 wide pane -> 300px gutter each side.
    expect(left.style.left).toBe('300px')
    expect(right.style.left).toBe('1300px')
  })

  it('commits twice the pointer travel when the right edge is dragged out', () => {
    const { right, onCommit } = renderHandles()
    drag(right, 1300, 1400)
    expect(onCommit).toHaveBeenCalledWith(1200)
  })

  it('grows the same way when the left edge is dragged out', () => {
    const { left, onCommit } = renderHandles()
    drag(left, 300, 200)
    expect(onCommit).toHaveBeenCalledWith(1200)
  })

  it('previews on the pane root during the drag, before anything is committed', () => {
    const { container, right, onCommit } = renderHandles()
    stubCapture(right)
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, clientX: 1300 })
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 1400 })
    expect(container.style.getPropertyValue('--pane-single-max-width')).toBe('1200px')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('writes nothing when the handle is clicked without moving', () => {
    const { right, onCommit } = renderHandles()
    drag(right, 1300, 1300)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('never commits wider than the tab', () => {
    const { right, onCommit } = renderHandles()
    drag(right, 1300, 9999)
    expect(onCommit).toHaveBeenCalledWith(1600)
  })
})

describe('an abandoned drag', () => {
  it('reverts the live preview and commits nothing when the pointer is cancelled', () => {
    const { container, right, onCommit } = renderHandles()
    stubCapture(right)
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, clientX: 1300 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    expect(container.style.getPropertyValue('--pane-single-max-width')).toBe('1200px')

    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    expect(onCommit).not.toHaveBeenCalled()
    expect(container.style.getPropertyValue('--pane-single-max-width')).toBe('')
  })

  it('reverts when the window loses focus mid-drag', () => {
    const { container, right, onCommit } = renderHandles()
    stubCapture(right)
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, clientX: 1300 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    fireEvent.blur(window)
    expect(onCommit).not.toHaveBeenCalled()
    expect(container.style.getPropertyValue('--pane-single-max-width')).toBe('')
  })

  it('does not strand the preview when the tab unmounts mid-drag', () => {
    const { container, right, unmount, onCommit } = renderHandles()
    stubCapture(right)
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, clientX: 1300 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    act(() => unmount())
    expect(container.style.getPropertyValue('--pane-single-max-width')).toBe('')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('still finishes when the release lands on the window instead of the handle', () => {
    const { right, onCommit } = renderHandles()
    stubCapture(right)
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, clientX: 1300 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1400, isPrimary: true })
    expect(onCommit).toHaveBeenCalledWith(1200)
  })
})

describe('hosts without the width cap', () => {
  it('renders nothing outside a retained pane host, where the pane is never capped', () => {
    const container = document.createElement('div')
    container.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 800)
    document.body.append(container)
    const ref = createRef<HTMLDivElement>()
    ref.current = container
    render(
      <TerminalSinglePaneWidthHandles
        containerRef={ref}
        maxWidth={1000}
        dividerStyle={{}}
        onCommit={vi.fn()}
      />
    )
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
  })
})
