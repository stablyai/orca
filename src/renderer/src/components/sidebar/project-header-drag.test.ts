// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import {
  isProjectHeaderDragHandleTarget,
  isRepoHeaderActionTarget,
  useRepoHeaderDrag
} from './project-header-drag'
import type { Repo } from '../../../../shared/types'

function createRepo(id: string, projectGroupId: string | null = null): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    projectGroupId,
    projectGroupOrder: 0
  }
}

function createPointerEvent(type: string, init: MouseEventInit & { pointerId: number }): Event {
  const event = new MouseEvent(type, { bubbles: true, ...init })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  return event
}

function createHeader(markup: string): HTMLElement {
  const header = document.createElement('div')
  header.setAttribute('data-repo-header-id', 'repo-1')
  header.innerHTML = markup
  document.body.appendChild(header)
  return header
}

describe('repo header action targets', () => {
  it('ignores explicit project action wrappers', () => {
    const header = createHeader(`
      <span data-repo-header-action="" tabindex="0">
        <span id="icon"></span>
      </span>
    `)

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores native nested controls', () => {
    const header = createHeader('<button type="button"><span id="icon"></span></button>')

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('does not ignore plain header text or the header itself', () => {
    const header = createHeader('<span id="label">Orca</span>')

    expect(isRepoHeaderActionTarget(header.querySelector('#label'), header)).toBe(false)
    expect(isRepoHeaderActionTarget(header, header)).toBe(false)
  })
})

describe('project header drag handle targets', () => {
  it('accepts pointer events on the project name handle', () => {
    const header = createHeader(`
      <span data-repo-header-drag-handle="" id="handle">Orca</span>
      <span id="chevron"></span>
    `)

    const handle = header.querySelector('#handle') as HTMLElement
    expect(isProjectHeaderDragHandleTarget(handle, handle)).toBe(true)
  })

  it('rejects pointer events outside the project name handle', () => {
    const header = createHeader(`
      <span data-repo-header-drag-handle="" id="handle">Orca</span>
      <span id="chevron"></span>
    `)

    expect(isProjectHeaderDragHandleTarget(header.querySelector('#chevron'), header)).toBe(false)
  })
})

describe('repo header drag pointer capture', () => {
  it('captures the pointer only after crossing the drag threshold', async () => {
    const scrollContainer = document.createElement('div')
    document.body.appendChild(scrollContainer)
    const repoById = new Map<string, Repo>([
      ['repo-a', createRepo('repo-a')],
      ['repo-b', createRepo('repo-b')]
    ])
    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])
    const setPointerCapture = vi.fn()

    function DragHarness(): React.ReactElement {
      const repoDrag = useRepoHeaderDrag({
        orderedRepoIds: ['repo-a', 'repo-b'],
        sidebarRepoHeaderIdsByBucket,
        repoById,
        usesProjectGroupOrdering: false,
        onCommitRepoOrder: vi.fn(),
        onCommitProjectGroupOrder: vi.fn(),
        getScrollContainer: () => scrollContainer
      })

      return createElement('div', {
        'data-repo-header-drag-handle': '',
        'data-repo-header-id': 'repo-a',
        'data-repo-header-index': 0,
        'data-repo-header-bucket': 'ungrouped',
        onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
          repoDrag.onHandlePointerDown(event, 'repo-a'),
        ref: (element: HTMLDivElement | null) => {
          if (element) {
            element.setPointerCapture = setPointerCapture
          }
        }
      })
    }

    const root = createRoot(scrollContainer)
    await act(async () => {
      root.render(createElement(DragHarness))
    })
    const handle = scrollContainer.querySelector<HTMLElement>('[data-repo-header-drag-handle]')
    expect(handle).not.toBeNull()

    await act(async () => {
      handle!.dispatchEvent(
        createPointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 7 })
      )
    })
    expect(setPointerCapture).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(
        createPointerEvent('pointermove', { clientX: 12, clientY: 12, pointerId: 7 })
      )
    })
    expect(setPointerCapture).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(
        createPointerEvent('pointermove', { clientX: 20, clientY: 20, pointerId: 7 })
      )
    })
    expect(setPointerCapture).toHaveBeenCalledWith(7)

    await act(async () => {
      root.unmount()
    })
  })
})
