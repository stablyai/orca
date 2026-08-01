// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PeerTerminalsSection from './PeerTerminalsSection'

const mocks = vi.hoisted(() => ({
  usePeerCollabClientConnection: vi.fn(),
  openPeersPage: vi.fn()
}))

let peersPageTarget: { hostId: string; handle: string; title: string } | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      peersPageTarget,
      openPeersPage: mocks.openPeersPage
    })
}))

vi.mock('@/components/peer-collab/use-peer-collab-client-connection', () => ({
  usePeerCollabClientConnection: mocks.usePeerCollabClientConnection
}))

function makeHost(
  overrides: Partial<{
    hostId: string
    endpoint: string | null
    state: string
    terminals: { handle: string; title: string }[]
  }> = {}
): {
  hostId: string
  endpoint: string | null
  status: { state: string }
  terminals: { handle: string; title: string }[]
} {
  const {
    hostId = 'host-1',
    endpoint = 'host.local:4123',
    state = 'connected',
    terminals = []
  } = overrides
  return { hostId, endpoint, status: { state }, terminals }
}

const mountedRoots: Root[] = []

async function renderSection(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<PeerTerminalsSection />)
  })
  return container
}

describe('PeerTerminalsSection', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    peersPageTarget = null
    mocks.openPeersPage.mockReset()
    mocks.usePeerCollabClientConnection.mockReset()
  })

  afterEach(() => {
    mountedRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('renders nothing when no host is connected', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hosts: [makeHost({ state: 'closed' })]
    })

    const container = await renderSection()

    expect(container.textContent).toBe('')
  })

  it('shows the empty state when a connected host has no shared terminals', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hosts: [makeHost({ terminals: [] })]
    })

    const container = await renderSection()

    expect(container.textContent).toContain('No terminals shared yet')
  })

  it('opens the peers page with the host id, handle, and title on click', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hosts: [makeHost({ hostId: 'host-1', terminals: [{ handle: 'term-1', title: 'build' }] })]
    })

    const container = await renderSection()
    const row = container.querySelector<HTMLButtonElement>('button')
    expect(row?.textContent).toContain('build')

    await act(async () => {
      row?.click()
    })

    expect(mocks.openPeersPage).toHaveBeenCalledWith({
      hostId: 'host-1',
      handle: 'term-1',
      title: 'build'
    })
  })

  it('highlights the row matching peersPageTarget hostId and handle', async () => {
    peersPageTarget = { hostId: 'host-2', handle: 'term-2', title: 'logs' }
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hosts: [
        makeHost({ hostId: 'host-1', terminals: [{ handle: 'term-1', title: 'build' }] }),
        makeHost({ hostId: 'host-2', terminals: [{ handle: 'term-2', title: 'logs' }] })
      ]
    })

    const container = await renderSection()
    const rows = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const selected = rows.find((row) => row.getAttribute('data-current') === 'true')

    expect(selected?.textContent).toContain('logs')
  })

  it('renders a group per connected host and skips disconnected ones', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hosts: [
        makeHost({ hostId: 'host-1', endpoint: 'a.local', terminals: [] }),
        makeHost({ hostId: 'host-2', endpoint: 'b.local', state: 'closed', terminals: [] })
      ]
    })

    const container = await renderSection()

    expect(container.textContent).toContain('a.local')
    expect(container.textContent).not.toContain('b.local')
  })
})
