// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import { useMaestroWorkspaceViewport } from './useMaestroWorkspaceViewport'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const persisted = { center: { x: 0, y: 0 }, zoom: 1 }
let root: Root
let container: HTMLDivElement
let board: ReturnType<typeof useMaestroWorkspaceViewport> | null = null

function resource(
  mutate: MaestroWorkspaceCanvasResource['mutate']
): MaestroWorkspaceCanvasResource {
  return {
    status: 'ready',
    result: null,
    unavailableReason: null,
    mutation: null,
    refresh: vi.fn(),
    mutate
  }
}

function Probe(props: {
  identity: string
  resource: MaestroWorkspaceCanvasResource
}): React.JSX.Element {
  board = useMaestroWorkspaceViewport({
    canvasRevision: 1,
    persisted,
    placements: {},
    mutationIdentity: props.identity,
    resource: props.resource
  })
  return createElement('main', { ref: board.canvasRef })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  board = null
  vi.useRealTimers()
})

describe('useMaestroWorkspaceViewport', () => {
  it('maps wheel gestures to zoom and axis-specific pan', async () => {
    const mutate = vi.fn().mockResolvedValue({ status: 'applied', authority_revision: 2 })
    await act(async () =>
      root.render(createElement(Probe, { identity: 'wheel', resource: resource(mutate) }))
    )
    const node = container.firstElementChild as HTMLElement
    const wheel = (modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => ({
      target: node,
      currentTarget: node,
      clientX: 0,
      clientY: 0,
      deltaX: 0,
      deltaY: 20,
      metaKey: false,
      shiftKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
      ...modifiers
    })

    act(() => board?.onWheel(wheel() as never))
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(board?.viewport.zoom).toBeLessThan(1)
    const zoomed = board?.viewport
    expect(zoomed).toBeTruthy()

    act(() => board?.onWheel(wheel({ ctrlKey: true }) as never))
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(board?.viewport.zoom).toBe(zoomed?.zoom)
    expect(board?.viewport.center.y).toBeGreaterThan(zoomed?.center.y ?? 0)
    const verticallyPanned = board?.viewport

    act(() => board?.onWheel(wheel({ shiftKey: true }) as never))
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(board?.viewport.center.x).toBeGreaterThan(verticallyPanned?.center.x ?? 0)
    expect(board?.viewport.center.y).toBe(verticallyPanned?.center.y)
  })

  it('persists the final accumulated pan after multiple moves before a render', async () => {
    const mutate = vi.fn().mockResolvedValue({ status: 'applied', authority_revision: 2 })
    await act(async () =>
      root.render(createElement(Probe, { identity: 'one', resource: resource(mutate) }))
    )
    const node = container.firstElementChild as HTMLElement
    const eventBase = { pointerId: 7, currentTarget: node, target: node }

    act(() => {
      board?.onPointerDown({ ...eventBase, button: 0, clientX: 100, clientY: 100 } as never)
      board?.onPointerMove({ ...eventBase, clientX: 120, clientY: 90 } as never)
      board?.onPointerMove({ ...eventBase, clientX: 150, clientY: 120 } as never)
      board?.onPointerUp({ ...eventBase } as never)
    })
    await act(async () => vi.advanceTimersByTimeAsync(140))

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set-viewport',
        viewport: { center: { x: -50, y: -20 }, zoom: 1 }
      })
    )
  })

  it('flushes a pending viewport to its original scope while leaving the Canvas', async () => {
    const firstMutate = vi.fn().mockResolvedValue({ status: 'applied', authority_revision: 2 })
    const secondMutate = vi.fn().mockResolvedValue({ status: 'applied', authority_revision: 2 })
    await act(async () =>
      root.render(
        createElement(Probe, {
          identity: 'workspace-one',
          resource: resource(firstMutate)
        })
      )
    )
    act(() => board?.zoom(1.2))
    await act(async () =>
      root.render(
        createElement(Probe, {
          identity: 'workspace-two',
          resource: resource(secondMutate)
        })
      )
    )

    expect(firstMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set-viewport',
        viewport: { center: { x: 0, y: 0 }, zoom: 1.2 }
      })
    )
    expect(secondMutate).not.toHaveBeenCalled()
  })

  it('serializes viewport commits and preserves the latest value', async () => {
    let releaseFirst!: () => void
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const mutate = vi
      .fn()
      .mockImplementationOnce(() => firstCommit)
      .mockResolvedValue(undefined)
    await act(async () =>
      root.render(
        createElement(Probe, {
          identity: 'workspace-one',
          resource: resource(mutate)
        })
      )
    )

    act(() => board?.zoom(1.2))
    await act(async () => vi.advanceTimersByTimeAsync(140))
    act(() => board?.zoom(1.2))
    await act(async () => vi.advanceTimersByTimeAsync(140))

    expect(mutate).toHaveBeenCalledTimes(1)
    releaseFirst()
    await act(async () => undefined)
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        action: 'set-viewport',
        viewport: { center: { x: 0, y: 0 }, zoom: 1.44 }
      })
    )
  })
})
