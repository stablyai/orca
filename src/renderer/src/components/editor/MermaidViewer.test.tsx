// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, content: string) => Promise<{ svg: string }>>()
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))

import MermaidViewer from './MermaidViewer'

const frames = new Map<number, FrameRequestCallback>()
const resizes = new Set<() => void>()
let nextFrame = 0

beforeEach(() => {
  scrollTopCache.clear()
  frames.clear()
  resizes.clear()
  mermaid.render.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(): void {
        resizes.add(this.callback)
      }
      disconnect(): void {
        resizes.delete(this.callback)
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  scrollTopCache.clear()
})

function diagramViewport(
  container: HTMLElement,
  renderedHeight = 1200,
  visible = () => true
): HTMLElement {
  const viewer = container.querySelector('.mermaid-viewer')
  if (!(viewer instanceof HTMLElement)) {
    throw new Error('Missing diagram viewport')
  }
  let scrollTop = 0
  Object.defineProperties(viewer, {
    clientHeight: { get: () => (visible() ? 100 : 0) },
    scrollHeight: {
      get: () =>
        !visible()
          ? 0
          : viewer.querySelector('.mermaid-block')?.hasChildNodes()
            ? renderedHeight
            : 100
    },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, viewer.scrollHeight - viewer.clientHeight))
      }
    }
  })
  return viewer
}

function advanceFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const scheduled = [...frames.values()]
    frames.clear()
    scheduled.forEach((callback) => callback(index * 16))
  }
}

describe('Mermaid diagram scroll restoration', () => {
  it('restores the cached position when rendering finishes after the old retry window', async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    scrollTopCache.set('/diagram.mmd:mermaid-diagram', 600)
    const { container } = render(
      <MermaidViewer scrollCacheKey="/diagram.mmd:mermaid-diagram" content="flowchart TD\nA-->B" />
    )
    const viewer = diagramViewport(container)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    act(() => advanceFrames(40))
    expect(viewer.scrollTop).toBe(0)

    await act(async () => pending.resolve({ svg: '<svg><text>Diagram</text></svg>' }))

    expect(viewer.scrollTop).toBe(600)
  })

  it('waits for a hidden workspace to become measurable after rendering completes', async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    scrollTopCache.set('/diagram.mmd:mermaid-diagram', 600)
    const { container } = render(
      <MermaidViewer scrollCacheKey="/diagram.mmd:mermaid-diagram" content="flowchart TD\nA-->B" />
    )
    let visible = false
    const viewer = diagramViewport(container, 1200, () => visible)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    await act(async () => pending.resolve({ svg: '<svg><text>Diagram</text></svg>' }))
    expect(viewer.scrollTop).toBe(0)

    visible = true
    act(() => resizes.forEach((callback) => callback()))

    expect(viewer.scrollTop).toBe(600)
  })
})
