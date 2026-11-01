// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { AreaSelectionCardRect } from './workspace-kanban-area-selection-card-rects'
import { updatePreviewSelection } from './workspace-kanban-area-selection-dom'

function makeRect({
  left,
  top,
  right,
  bottom
}: {
  left: number
  top: number
  right: number
  bottom: number
}): AreaSelectionCardRect['rect'] {
  return { left, top, right, bottom }
}

describe('workspace kanban area selection preview remount', () => {
  it('re-applies the preview attribute when a card remounts under the same id', () => {
    const first = document.createElement('div')
    first.setAttribute('data-workspace-board-card-id', 'card-a')
    Object.defineProperty(first, 'isConnected', { value: true })
    const previewIds = new Set<string>()
    updatePreviewSelection(
      [
        {
          id: 'card-a',
          element: first,
          rect: makeRect({ left: 0, top: 0, right: 100, bottom: 40 }),
          scrollContainer: null,
          contentRect: null
        }
      ],
      previewIds,
      new Set(),
      false,
      ['card-a']
    )
    expect(first.getAttribute('data-workspace-board-card-area-selected')).toBe('true')
    expect(previewIds.has('card-a')).toBe(true)

    const remounted = document.createElement('div')
    remounted.setAttribute('data-workspace-board-card-id', 'card-a')
    Object.defineProperty(remounted, 'isConnected', { value: true })
    updatePreviewSelection(
      [
        {
          id: 'card-a',
          element: remounted,
          rect: makeRect({ left: 0, top: 0, right: 100, bottom: 40 }),
          scrollContainer: null,
          contentRect: null
        }
      ],
      previewIds,
      new Set(),
      false,
      ['card-a']
    )
    expect(remounted.getAttribute('data-workspace-board-card-area-selected')).toBe('true')
  })
})
