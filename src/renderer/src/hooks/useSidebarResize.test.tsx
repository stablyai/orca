// @vitest-environment happy-dom
import { memo } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSidebarResize } from './useSidebarResize'

afterEach(cleanup)

function Host({ isOpen, setWidth }: { isOpen: boolean; setWidth: (width: number) => void }) {
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen,
    width: 300,
    minWidth: 200,
    maxWidth: 800,
    deltaSign: -1,
    setWidth
  })
  return (
    <div ref={containerRef} data-testid="sidebar">
      <div data-testid="handle" onMouseDown={onResizeStart} />
    </div>
  )
}

const MemoHost = memo(Host)

describe('useSidebarResize', () => {
  it('a sidebar opened after mount keeps its dragged width in a memo host', () => {
    const setWidth = vi.fn()
    const { getByTestId, rerender } = render(<MemoHost isOpen={false} setWidth={setWidth} />)
    rerender(<MemoHost isOpen setWidth={setWidth} />)

    fireEvent.mouseDown(getByTestId('handle'), { clientX: 1000 })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(getByTestId('sidebar').style.width).toBe('400px')
    expect(setWidth).toHaveBeenCalledWith(400)
  })
})
