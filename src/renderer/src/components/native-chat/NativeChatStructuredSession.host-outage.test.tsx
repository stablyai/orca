// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const reconnectHost = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reconnectHost
}))

import { useAppStore } from '@/store'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS } from './use-native-chat-host-outage'

const initialState = useAppStore.getState()
let sequence = 0

function hostStatus(
  verification: 'verified' | 'unavailable' | 'blocked',
  transport: 'ready' | 'disconnected',
  retired?: true
): RuntimeEnvironmentStatus {
  const status =
    verification === 'verified'
      ? {
          runtimeId: 'runtime-1',
          rendererGraphEpoch: 1,
          graphStatus: 'ready' as const,
          authoritativeWindowId: 1,
          desktopWindowStatus: 'available' as const,
          liveTabCount: 0,
          liveLeafCount: 0
        }
      : null
  return {
    snapshot: {
      environmentId: 'remote-host',
      pairingRevision: 1,
      sequence: ++sequence,
      checkedAt: 1,
      status,
      verification,
      transport,
      ...(retired ? { retired } : {})
    },
    status,
    checkedAt: 1
  }
}

function setHost(status: RuntimeEnvironmentStatus): void {
  act(() => {
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['remote-host', status]]) })
  })
}

function renderPane(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-host-outage-tab"
      sessionId="host-outage-session"
      target={{ kind: 'environment', environmentId: 'remote-host' }}
      agent="claude"
    />
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useAppStore.setState({
    runtimeEnvironments: [
      {
        id: 'remote-host',
        name: 'Build box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws', kind: 'websocket', label: 'ws', endpoint: 'ws://host' }],
        preferredEndpointId: 'ws'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([['remote-host', hostStatus('verified', 'ready')]])
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetStructuredSessionMocks()
  reconnectHost.mockReset()
  useAppStore.setState({
    runtimeEnvironments: initialState.runtimeEnvironments,
    runtimeStatusByEnvironmentId: initialState.runtimeStatusByEnvironmentId
  })
})

// The chat's own stream retrying is not the host's outage: with the host up, nothing is said.
it('adds no host line and no read line to a loaded chat while its host stays connected', () => {
  renderPane()
  act(() => {
    vi.advanceTimersByTime(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS * 2)
  })

  expect(screen.getByTestId('message-list')).toBeTruthy()
  expect(screen.queryByText(/reconnect|offline|couldn't be loaded/i)).toBeNull()
})

it('names a reconnecting host above the composer only once the grace has passed', () => {
  renderPane()
  // Mounted before its words arrive, so a screen reader announces them.
  const region = screen.getByRole('status')
  expect(region.textContent).toBe('')
  setHost(hostStatus('unavailable', 'disconnected'))
  act(() => {
    vi.advanceTimersByTime(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS - 1)
  })
  expect(screen.queryByText(/Build box/)).toBeNull()

  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(region.textContent).toBe('Build box is reconnecting…')
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  expect(screen.getByTestId('structured-composer')).toBeTruthy()

  setHost(hostStatus('verified', 'ready'))
  expect(screen.queryByText(/Build box/)).toBeNull()
})

it('says a disconnected host is offline at once and offers Reconnect', async () => {
  mocks.hasOlder = true
  renderPane()
  setHost(hostStatus('blocked', 'disconnected', true))

  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(mocks.messageListProps?.session?.hasMore).toBe(false)

  reconnectHost.mockResolvedValue(true)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  })
  expect(reconnectHost).toHaveBeenCalledWith('remote-host')
})

it('offers no Reconnect for a host that refused us, and promises no delivery in the composer', () => {
  renderPane()
  setHost(hostStatus('blocked', 'disconnected'))

  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  // A send now fails and waits for its own Retry, so nothing may say it will go out later.
  expect(mocks.composerProps?.structuredTransport).not.toHaveProperty('placeholder')
  expect(screen.queryByText(/Messages send when/)).toBeNull()
})

it('says the outage once: a lost read beside messages adds no line of its own', () => {
  mocks.status = 'error'
  renderPane()
  setHost(hostStatus('blocked', 'disconnected'))

  expect(screen.getByTestId('message-list')).toBeTruthy()
  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(screen.queryByText(/couldn't be loaded/)).toBeNull()
})

it('says the outage once: a chat that never loaded waits quietly instead of failing', () => {
  mocks.status = 'error'
  mocks.messages = []
  renderPane()
  setHost(hostStatus('blocked', 'disconnected'))

  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(screen.queryByText('Could not load conversation')).toBeNull()
  expect(screen.queryByText(/keeps trying/)).toBeNull()
})

it("still words a refusal the host itself sent beside the host's outage", () => {
  mocks.status = 'error'
  mocks.readRefusal = {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalUnavailable' }
  } as const
  renderPane()
  setHost(hostStatus('blocked', 'disconnected'))

  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(screen.getByText("Orca couldn't open this chat's history right now.")).toBeTruthy()
})
