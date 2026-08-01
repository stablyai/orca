// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import { PeersPanels } from './PeersPanels'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ peersPageSplitTarget: null, setPeersPageSplitTarget: vi.fn() })
}))

vi.mock('@/components/peer-collab/RemoteTerminalPanel', () => ({
  RemoteTerminalPanel: (props: { hostId: string; terminalHandle: string; hidden?: boolean }) => (
    <div
      data-testid={`panel-${props.hostId}:${props.terminalHandle}`}
      data-hidden={String(Boolean(props.hidden))}
    />
  )
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

const mountedRoots: Root[] = []

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
    root.render(<PeersPanels hosts={hosts} primary={primary} />)
  })
  const rerender = async (nextPrimary: RemoteTerminalTarget): Promise<void> => {
    await act(async () => {
      root.render(<PeersPanels hosts={hosts} primary={nextPrimary} />)
    })
  }
  return { container, rerender }
}

describe('PeersPanels keep-alive stack', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    mountedRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
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
