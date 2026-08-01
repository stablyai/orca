// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { DndContext } from '@dnd-kit/core'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import type { PeersLayoutNode } from './peers-split-tree'
import { PeersPanels } from './PeersPanels'

const closePeersPane = vi.fn()
const setPeersPageTarget = vi.fn()
const setPeersPaneRatio = vi.fn()
const splitPeersPane = vi.fn()
let peersLayout: PeersLayoutNode | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      peersLayout,
      setPeersPageTarget,
      setPeersPaneRatio,
      closePeersPane,
      splitPeersPane
    })
}))

let mountCounts: Record<string, number> = {}

vi.mock('@/components/peer-collab/RemoteTerminalPanel', () => ({
  RemoteTerminalPanel: (props: { hostId: string; terminalHandle: string; hidden?: boolean }) => {
    const key = `${props.hostId}:${props.terminalHandle}`
    // Why: an empty-deps effect only fires once per DOM mount — a rerender that keeps
    // the same key must not bump this, only an actual unmount+remount would.
    useEffect(() => {
      mountCounts[key] = (mountCounts[key] ?? 0) + 1
    }, [key])
    return (
      <div
        data-testid={`panel-${key}`}
        data-hidden={String(Boolean(props.hidden))}
        data-mount-count={mountCounts[key]}
      />
    )
  }
}))

function makeHost(terminals: { handle: string; title: string }[]): PeerHostConnection {
  return {
    hostId: 'host-1',
    endpoint: 'host.local:4123',
    status: { state: 'connected' },
    terminals
  } as unknown as PeerHostConnection
}

function target(handle: string): RemoteTerminalTarget {
  return { hostId: 'host-1', handle, title: handle }
}

function leaf(handle: string): PeersLayoutNode {
  return { type: 'leaf', target: target(handle) }
}

const mountedRoots: Root[] = []

// Why: ResizeObserver isn't implemented in happy-dom — the tree-layout path needs a
// non-zero container size, so this stub fires once synchronously with a fixed size.
class StubResizeObserver {
  private callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element): void {
    this.callback(
      [{ target, contentRect: { width: 400, height: 200 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}

async function renderPanels(
  hosts: PeerHostConnection[],
  primary: RemoteTerminalTarget
): Promise<{
  container: HTMLDivElement
  rerender: (nextPrimary: RemoteTerminalTarget) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <DndContext>
        <PeersPanels hosts={hosts} primary={primary} />
      </DndContext>
    )
  })
  const rerender = async (nextPrimary: RemoteTerminalTarget): Promise<void> => {
    await act(async () => {
      root.render(
        <DndContext>
          <PeersPanels hosts={hosts} primary={nextPrimary} />
        </DndContext>
      )
    })
  }
  return { container, rerender }
}

describe('PeersPanels keep-alive stack', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    peersLayout = null
    mountCounts = {}
    vi.clearAllMocks()
  })

  afterEach(() => {
    mountedRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('keeps the previous tab mounted and hidden after switching tabs', async () => {
    const hosts = [
      makeHost([
        { handle: 'a', title: 'A' },
        { handle: 'b', title: 'B' }
      ])
    ]
    const { container, rerender } = await renderPanels(hosts, target('a'))

    expect(
      container.querySelector('[data-testid="panel-host-1:a"]')?.getAttribute('data-hidden')
    ).toBe('false')

    await rerender(target('b'))

    const panelA = container.querySelector('[data-testid="panel-host-1:a"]')
    const panelB = container.querySelector('[data-testid="panel-host-1:b"]')
    expect(panelA).not.toBeNull()
    expect(panelA?.getAttribute('data-hidden')).toBe('true')
    expect(panelB?.getAttribute('data-hidden')).toBe('false')
  })

  it('evicts the oldest non-active tab once the keep-alive cap is exceeded', async () => {
    const terminals = ['a', 'b', 'c', 'd', 'e'].map((handle) => ({ handle, title: handle }))
    const hosts = [makeHost(terminals)]
    const { container, rerender } = await renderPanels(hosts, target('a'))

    await rerender(target('b'))
    await rerender(target('c'))
    await rerender(target('d'))
    // Cap is 4 — visiting a 5th distinct target must evict the least-recently-visited one ('a').
    await rerender(target('e'))

    expect(container.querySelector('[data-testid="panel-host-1:a"]')).toBeNull()
    for (const handle of ['b', 'c', 'd', 'e']) {
      expect(container.querySelector(`[data-testid="panel-host-1:${handle}"]`)).not.toBeNull()
    }
  })
})

describe('PeersPanels split tree layout', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    mountCounts = {}
    vi.clearAllMocks()
  })

  afterEach(() => {
    mountedRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    peersLayout = null
  })

  it('shows every tree leaf visible and hides mounted panes outside the tree', async () => {
    peersLayout = { type: 'split', direction: 'row', first: leaf('a'), second: leaf('b') }
    const hosts = [
      makeHost([
        { handle: 'a', title: 'A' },
        { handle: 'b', title: 'B' },
        { handle: 'c', title: 'C' }
      ])
    ]
    // 'c' was visited earlier (e.g. before a pane closed) and lingers in the LRU stack.
    const { container, rerender } = await renderPanels(hosts, target('c'))
    peersLayout = { type: 'split', direction: 'row', first: leaf('a'), second: leaf('b') }
    await rerender(target('a'))

    expect(
      container.querySelector('[data-testid="panel-host-1:a"]')?.getAttribute('data-hidden')
    ).toBe('false')
    expect(
      container.querySelector('[data-testid="panel-host-1:b"]')?.getAttribute('data-hidden')
    ).toBe('false')
    expect(
      container.querySelector('[data-testid="panel-host-1:c"]')?.getAttribute('data-hidden')
    ).toBe('true')
  })

  it('does not remount a leaf panel when the tree changes shape around it', async () => {
    peersLayout = { type: 'split', direction: 'row', first: leaf('a'), second: leaf('b') }
    const hosts = [
      makeHost([
        { handle: 'a', title: 'A' },
        { handle: 'b', title: 'B' },
        { handle: 'c', title: 'C' }
      ])
    ]
    const { container, rerender } = await renderPanels(hosts, target('a'))
    const mountCountBefore = mountCounts['host-1:a']

    // Move 'a' deeper into a nested split (b becomes a sibling of a new pane c).
    peersLayout = {
      type: 'split',
      direction: 'row',
      first: leaf('a'),
      second: { type: 'split', direction: 'column', first: leaf('b'), second: leaf('c') }
    }
    await rerender(target('a'))

    expect(mountCounts['host-1:a']).toBe(mountCountBefore)
    expect(container.querySelector('[data-testid="panel-host-1:a"]')).not.toBeNull()
  })

  it('calls closePeersPane when the pane close button is clicked', async () => {
    peersLayout = { type: 'split', direction: 'row', first: leaf('a'), second: leaf('b') }
    const hosts = [
      makeHost([
        { handle: 'a', title: 'A' },
        { handle: 'b', title: 'B' }
      ])
    ]
    const { container } = await renderPanels(hosts, target('a'))

    const closeButton = container.querySelector(
      '[aria-label="Close pane"]'
    ) as HTMLButtonElement | null
    expect(closeButton).not.toBeNull()
    await act(async () => {
      closeButton?.click()
    })

    expect(closePeersPane).toHaveBeenCalledWith('host-1:a')
  })
})
