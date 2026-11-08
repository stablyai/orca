// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSidebarResize } from './useSidebarResize'

// A flex item rendered at a width other than its stored one, like a squeezed or stretched tab.
function setup(renderedWidth: number) {
  const setWidth = vi.fn()
  function Resizable(): React.JSX.Element {
    const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
      isOpen: true,
      width: 330,
      minWidth: 144,
      maxWidth: 640,
      deltaSign: 1,
      setWidth,
      getStartWidth: () => renderedWidth
    })
    return <div ref={containerRef} data-testid="resizable" onMouseDown={onResizeStart} />
  }
  const element = within(render(<Resizable />).container).getByTestId('resizable')
  const press = (clientX: number): void => {
    fireEvent.mouseDown(element, { clientX })
  }
  const moveTo = (clientX: number): void =>
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX }))
    })
  const release = (): void =>
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
  return { element, setWidth, press, moveTo, release }
}

// Unmounting also ends any drag left open, removing its window listeners and overlay.
afterEach(cleanup)

describe('useSidebarResize with a measured start width', () => {
  it('keeps the rendered width when the grip is pressed instead of snapping to the stored one', () => {
    const { element, press } = setup(291)

    press(500)

    expect(element.style.width).toBe('291px')
  })

  it('saves a drag that ends exactly at the stored width', () => {
    const { setWidth, press, moveTo, release } = setup(400)

    press(500)
    moveTo(430)
    release()

    expect(setWidth).toHaveBeenCalledWith(330)
  })

  it('saves nothing for a press without movement and restores the stored width', () => {
    const { element, setWidth, press, release } = setup(291)

    press(500)
    release()

    expect(setWidth).not.toHaveBeenCalled()
    expect(element.style.width).toBe('330px')
  })
})
