// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalPaneViewerBadge } from './TerminalPaneViewerBadge'
import type { ConnectedPeerClient } from '@/components/settings/PeerCollabConnectedClientsSection'

const resolveHandleMocks = vi.hoisted(() => ({
  resolveTerminalHandleForPane: vi.fn()
}))

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

vi.mock('./terminal-handle-copy', () => resolveHandleMocks)

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback
      .replace('{{count}}', String(values?.count ?? ''))
      .replace('{{name}}', String(values?.name ?? ''))
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

function viewer(overrides: Partial<ConnectedPeerClient> = {}): ConnectedPeerClient {
  return {
    connectionId: 'conn-1',
    deviceId: 'device-1',
    name: 'Alice',
    connectedAt: 1_700_000_000_000,
    subscribedTerminals: ['term_worker'],
    grantedTerminals: ['term_worker'],
    ...overrides
  }
}

function installPeerCollabApi(
  overrides: {
    disconnectClient?: ReturnType<typeof vi.fn>
    setGrantedTerminals?: ReturnType<typeof vi.fn>
  } = {}
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: { call: vi.fn() },
      peerCollab: {
        disconnectClient: overrides.disconnectClient ?? vi.fn(),
        setGrantedTerminals: overrides.setGrantedTerminals ?? vi.fn()
      }
    }
  })
}

describe('TerminalPaneViewerBadge', () => {
  beforeEach(() => {
    resolveHandleMocks.resolveTerminalHandleForPane.mockReset()
    toastMocks.error.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when no client is connected', async () => {
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi()

    const { container } = render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() => expect(resolveHandleMocks.resolveTerminalHandleForPane).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('retries handle resolution until a freshly opened pane registers its PTY', async () => {
    vi.useFakeTimers()
    try {
      resolveHandleMocks.resolveTerminalHandleForPane
        .mockResolvedValueOnce(null)
        .mockResolvedValue('term_worker')
      installPeerCollabApi()

      const { container } = render(
        <TerminalPaneViewerBadge
          tabId="tab-1"
          leafId="leaf-1"
          connectedClients={[viewer({ subscribedTerminals: [] })]}
          onConnectedClientsChanged={vi.fn()}
        />
      )

      await vi.waitFor(() =>
        expect(resolveHandleMocks.resolveTerminalHandleForPane).toHaveBeenCalledTimes(1)
      )
      expect(container).toBeEmptyDOMElement()

      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(() =>
        expect(resolveHandleMocks.resolveTerminalHandleForPane).toHaveBeenCalledTimes(2)
      )
      await vi.waitFor(() =>
        expect(screen.getByLabelText('1 granted access to this terminal')).toBeInTheDocument()
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the badge for a connected client that is not watching this pane', async () => {
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer({ subscribedTerminals: [] })]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('1 granted access to this terminal')).toBeInTheDocument()
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('shows a zero count when clients are connected but none is granted this terminal', async () => {
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer({ subscribedTerminals: [], grantedTerminals: [] })]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(
        screen.getByLabelText('1 connected, no access granted to this terminal')
      ).toBeInTheDocument()
    )
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('lists both watching and non-watching connected clients, distinguished', async () => {
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[
          viewer({ connectionId: 'conn-1', name: 'Alice', subscribedTerminals: ['term_worker'] }),
          viewer({
            connectionId: 'conn-2',
            deviceId: 'device-2',
            name: 'Bob',
            subscribedTerminals: ['term_other'],
            grantedTerminals: []
          })
        ]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('1 viewing this terminal')).toBeInTheDocument())
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })

  it('toggles the granted handle on for a client that is not yet shared with', async () => {
    const setGrantedTerminals = vi.fn().mockResolvedValue({ ok: true })
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi({ setGrantedTerminals })
    const onConnectedClientsChanged = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer({ subscribedTerminals: [], grantedTerminals: ['term_other'] })]}
        onConnectedClientsChanged={onConnectedClientsChanged}
      />
    )

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    await user.click(screen.getByRole('checkbox'))

    expect(setGrantedTerminals).toHaveBeenCalledWith({
      deviceId: 'device-1',
      handles: ['term_other', 'term_worker']
    })
    await waitFor(() => expect(onConnectedClientsChanged).toHaveBeenCalled())
  })

  it('toggles the granted handle off for a client that is currently shared with', async () => {
    const setGrantedTerminals = vi.fn().mockResolvedValue({ ok: true })
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi({ setGrantedTerminals })
    const user = userEvent.setup()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer({ grantedTerminals: ['term_worker'] })]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    await user.click(screen.getByRole('checkbox'))

    expect(setGrantedTerminals).toHaveBeenCalledWith({ deviceId: 'device-1', handles: [] })
  })

  it('disconnects a viewer without revoking the device', async () => {
    const disconnectClient = vi.fn().mockResolvedValue({ revoked: false })
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi({ disconnectClient })
    const user = userEvent.setup()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer()]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    await user.click(screen.getByTitle('Disconnect'))

    expect(disconnectClient).toHaveBeenCalledWith({ deviceId: 'device-1', revokeDevice: false })
  })

  it('surfaces a toast when disconnecting a viewer fails', async () => {
    const disconnectClient = vi.fn().mockRejectedValue(new Error('offline'))
    resolveHandleMocks.resolveTerminalHandleForPane.mockResolvedValue('term_worker')
    installPeerCollabApi({ disconnectClient })
    const user = userEvent.setup()

    render(
      <TerminalPaneViewerBadge
        tabId="tab-1"
        leafId="leaf-1"
        connectedClients={[viewer()]}
        onConnectedClientsChanged={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    await user.click(screen.getByTitle('Disconnect'))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('Failed to disconnect client')
    )
  })
})
