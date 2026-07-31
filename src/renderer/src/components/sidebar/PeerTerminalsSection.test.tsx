// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PeerTerminalsSection from './PeerTerminalsSection'

const mocks = vi.hoisted(() => ({
  usePeerCollabClientConnection: vi.fn(),
  openPeersPage: vi.fn()
}))

let peersPageTarget: { handle: string; title: string } | null = null

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

function makeClientStatus(overrides: Partial<{ state: string; endpoint: string | null }> = {}): {
  state: string
  endpoint: string | null
} {
  return { state: 'connected', endpoint: 'host.local:4123', ...overrides }
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

  it('renders nothing when the client is not connected to a host', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hostTerminals: [],
      clientStatus: makeClientStatus({ state: 'closed' })
    })

    const container = await renderSection()

    expect(container.textContent).toBe('')
  })

  it('shows the empty state when the host has no shared terminals', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hostTerminals: [],
      clientStatus: makeClientStatus()
    })

    const container = await renderSection()

    expect(container.textContent).toContain('No terminals shared yet')
  })

  it('opens the peers page with the row handle and title on click', async () => {
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hostTerminals: [{ handle: 'term-1', title: 'build' }],
      clientStatus: makeClientStatus()
    })

    const container = await renderSection()
    const row = container.querySelector<HTMLButtonElement>('button')
    expect(row?.textContent).toContain('build')

    await act(async () => {
      row?.click()
    })

    expect(mocks.openPeersPage).toHaveBeenCalledWith({ handle: 'term-1', title: 'build' })
  })

  it('highlights the row matching peersPageTarget.handle', async () => {
    peersPageTarget = { handle: 'term-2', title: 'logs' }
    mocks.usePeerCollabClientConnection.mockReturnValue({
      hostTerminals: [
        { handle: 'term-1', title: 'build' },
        { handle: 'term-2', title: 'logs' }
      ],
      clientStatus: makeClientStatus()
    })

    const container = await renderSection()
    const rows = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const selected = rows.find((row) => row.getAttribute('data-current') === 'true')

    expect(selected?.textContent).toContain('logs')
  })
})
