import { describe, expect, it, vi } from 'vitest'

const { createPortalMock } = vi.hoisted(() => ({
  createPortalMock: vi.fn((node: unknown) => node)
}))

vi.mock('react-dom', () => ({
  createPortal: createPortalMock
}))

import TabPaneColumnSplitDragOverlay from './TabPaneColumnSplitDragOverlay'

function rect({
  left,
  top,
  width,
  height
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  } as DOMRect
}

type ReactElementLike = {
  props: Record<string, unknown>
}

describe('TabPaneColumnSplitDragOverlay', () => {
  it('renders from cached panel bounds without reading layout during render', () => {
    const querySelector = vi.fn()
    vi.stubGlobal('document', {
      body: {},
      querySelector
    })

    const overlay = TabPaneColumnSplitDragOverlay({
      panelRect: rect({ left: 100, top: 20, width: 400, height: 300 }),
      zone: 'right'
    })

    expect(querySelector).not.toHaveBeenCalled()
    expect((overlay as ReactElementLike).props.style).toEqual({
      top: 20,
      left: 300,
      width: 200,
      height: 300
    })

    vi.unstubAllGlobals()
  })
})
