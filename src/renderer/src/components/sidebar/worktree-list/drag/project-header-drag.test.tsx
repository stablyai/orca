// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { useRepoHeaderDrag } from './project-header-drag'

function makeRepo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1
  }
}

function makeRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 240,
    bottom: top + height,
    width: 240,
    height,
    toJSON: () => ({})
  }
}

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: {
    pointerId: number
    pointerType: string
    button?: number
    buttons?: number
    clientX?: number
    clientY?: number
  }
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: init.pointerId,
    pointerType: init.pointerType,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
    clientX: init.clientX ?? 20,
    clientY: init.clientY ?? 14
  })
}

function setupHarness(repos: readonly Repo[]) {
  const onCommitRepoOrder = vi.fn()
  const onCommitProjectGroupOrder = vi.fn()
  const orderedRepoIds = repos.map((repo) => repo.id)
  const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', orderedRepoIds]])
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  let draggingRepoId: string | null = null

  function Harness(): React.JSX.Element {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const { state, onHandlePointerDown } = useRepoHeaderDrag({
      orderedRepoIds,
      sidebarRepoHeaderIdsByBucket,
      repoById,
      getLiveRepos: () => repos,
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder,
      getScrollContainer: () => scrollRef.current
    })
    draggingRepoId = state.draggingRepoId

    return (
      <div ref={scrollRef} data-testid="scroll-container">
        {repos.map((repo, index) => (
          <div
            key={repo.id}
            data-repo-header-id={repo.id}
            data-repo-header-index={index}
            data-repo-header-bucket="ungrouped"
            data-repo-header-drag-handle=""
            onPointerDown={(event) => onHandlePointerDown(event, repo)}
          >
            <div data-repo-header-drag-handle="">{repo.displayName}</div>
          </div>
        ))}
      </div>
    )
  }

  const rendered = render(<Harness />)
  const container = rendered.getByTestId('scroll-container')
  container.getBoundingClientRect = () => makeRect(0, 200)
  Object.defineProperty(container, 'scrollHeight', { value: 200, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true })

  const headers = repos.map((repo, index) => {
    const header = container.querySelector<HTMLElement>(`[data-repo-header-id="${repo.id}"]`)!
    header.getBoundingClientRect = () => makeRect(index * 28, 28)
    return header
  })

  return { headers, onCommitRepoOrder, getDraggingRepoId: () => draggingRepoId }
}

describe('useRepoHeaderDrag WSLg pointer handoff', () => {
  afterEach(cleanup)

  it('commits reorder when mouse pointerdown receives pen motion with a different pointerId and mouse pointerup', () => {
    const { headers, onCommitRepoOrder } = setupHarness([makeRepo('repo-1'), makeRepo('repo-2')])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['repo-2', 'repo-1'])
  })

  it('commits reorder when pointerup arrives on the adopted pen pointerId', () => {
    const { headers, onCommitRepoOrder } = setupHarness([makeRepo('repo-1'), makeRepo('repo-2')])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['repo-2', 'repo-1'])
  })

  it('ignores pen hover without primary button and isolates a second pen pointerId after adoption', () => {
    const { headers, onCommitRepoOrder } = setupHarness([
      makeRepo('repo-1'),
      makeRepo('repo-2'),
      makeRepo('repo-3')
    ])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    // Unrelated pen hover with buttons=0 must neither promote nor cancel the armed mouse session.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 9,
          pointerType: 'pen',
          buttons: 0,
          clientY: 80
        })
      )
    })
    // Adopt pen pointerId 3 at repo-2's slot, then send a different pen pointerId 4 at repo-3.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 4,
          pointerType: 'pen',
          buttons: 1,
          clientY: 80
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['repo-2', 'repo-1', 'repo-3'])
  })

  it('cancels an adopted pen drag on pointercancel without committing', () => {
    const { headers, onCommitRepoOrder, getDraggingRepoId } = setupHarness([
      makeRepo('repo-1'),
      makeRepo('repo-2')
    ])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    expect(getDraggingRepoId()).toBe('repo-1')
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointercancel', {
          pointerId: 3,
          pointerType: 'pen'
        })
      )
    })
    expect(getDraggingRepoId()).toBeNull()
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).not.toHaveBeenCalled()
  })

  it('keeps pen and touch drags isolated to their initiating pointerId', () => {
    const { headers, onCommitRepoOrder } = setupHarness([makeRepo('repo-1'), makeRepo('repo-2')])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 4,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 0,
          clientY: 14
        })
      )
    })

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 2,
          pointerType: 'touch',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 5,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 2,
          pointerType: 'touch',
          button: 0,
          buttons: 0,
          clientY: 14
        })
      )
    })

    expect(onCommitRepoOrder).not.toHaveBeenCalled()

    // Normal same-ID pen drag still commits.
    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['repo-2', 'repo-1'])
  })

  it('does not adopt an independent pen pointerdown during a mouse drag while preserving move-only WSLg handoff', () => {
    const { headers, onCommitRepoOrder, getDraggingRepoId } = setupHarness([
      makeRepo('repo-1'),
      makeRepo('repo-2'),
      makeRepo('repo-3')
    ])

    act(() => {
      headers[0]!.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
    })
    // Independent pen contact elsewhere in the window must not be adopted, move, or commit the mouse drag.
    act(() => {
      document.body.dispatchEvent(
        pointerEvent('pointerdown', {
          pointerId: 7,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientY: 14
        })
      )
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 7,
          pointerType: 'pen',
          buttons: 1,
          clientY: 80
        })
      )
    })
    expect(getDraggingRepoId()).toBeNull()
    act(() => {
      document.body.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 7,
          pointerType: 'pen',
          button: 0,
          buttons: 0,
          clientY: 80
        })
      )
    })
    expect(onCommitRepoOrder).not.toHaveBeenCalled()

    // A subsequent move-only WSLg pen handoff (no pointerdown) still drives and commits the active drag.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          pointerId: 3,
          pointerType: 'pen',
          buttons: 1,
          clientY: 50
        })
      )
    })
    expect(getDraggingRepoId()).toBe('repo-1')
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 0,
          clientY: 50
        })
      )
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['repo-2', 'repo-1', 'repo-3'])
  })
})
