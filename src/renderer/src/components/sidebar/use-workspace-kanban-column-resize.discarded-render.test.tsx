// @vitest-environment happy-dom

import React, { Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceKanbanColumnResize } from './use-workspace-kanban-column-resize'

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
const settledWidths = new Set<number>()
let releasePending: (() => void) | null = null

/** Suspends the first render of each unseen width so the sibling probe's render is discarded. */
function SuspendOnNewWidth({ width }: { width: number }): null {
  if (!settledWidths.has(width)) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        settledWidths.add(width)
        resolve()
      }
    })
  }
  return null
}

const commitWidth = vi.fn()

/** Exposes the hook's width and keyboard handler next to the suspender that discards the render. */
function ColumnProbe({ committedWidth }: { committedWidth: number }): React.JSX.Element {
  const { columnWidth, onColumnResizeKeyDown } = useWorkspaceKanbanColumnResize(
    committedWidth,
    commitWidth
  )
  return (
    <>
      <span data-testid="width" tabIndex={0} onKeyDown={onColumnResizeKeyDown}>
        {columnWidth}
      </span>
      <SuspendOnNewWidth width={committedWidth} />
    </>
  )
}

/** Wraps the probe in the Suspense boundary that a width change unwinds. */
function boundary(committedWidth: number): React.JSX.Element {
  return (
    <Suspense fallback={<span data-testid="fallback">loading</span>}>
      <ColumnProbe committedWidth={committedWidth} />
    </Suspense>
  )
}

beforeEach(() => {
  settledWidths.clear()
  settledWidths.add(320)
  releasePending = null
  commitWidth.mockReset()
})

afterEach(cleanup)

describe('useWorkspaceKanbanColumnResize external width', () => {
  it('adopts a committed width even when the adopting render is discarded', async () => {
    const { rerender } = render(boundary(320))
    expect(screen.getByTestId('width').textContent).toBe('320')

    rerender(boundary(420))
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByTestId('width').textContent).toBe('420')
  })

  it('resizes from the committed width after a discarded width change is reverted', () => {
    const { rerender } = render(boundary(320))
    rerender(boundary(420))
    expect(screen.getByTestId('fallback')).toBeTruthy()
    rerender(boundary(320))
    expect(screen.getByTestId('width').textContent).toBe('320')

    fireEvent.keyDown(screen.getByTestId('width'), { key: 'ArrowRight' })

    expect(commitWidth).toHaveBeenCalledWith(340)
  })
})
