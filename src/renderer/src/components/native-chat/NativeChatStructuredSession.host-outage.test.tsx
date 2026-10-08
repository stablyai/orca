// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

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

function paneElement(): React.JSX.Element {
  return (
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

function renderPane() {
  return render(paneElement())
}

function promptItem(kind: 'approval' | 'question'): AgentJournalRenderItem {
  const options = [{ id: 'allow', label: 'Approve' }]
  const resolution = {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
  return {
    itemId: 'host-outage-prompt',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body:
      kind === 'approval'
        ? {
            kind,
            title: 'Run the plan?',
            detail: null,
            subject: { kind: 'plan', text: 'x' },
            options,
            resolution
          }
        : { kind, question: 'Run the plan?', options, resolution }
  }
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
  const region = screen.getByRole('list')
  expect(region).toHaveAttribute('aria-live', 'polite')
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
  expect(screen.getByText('Build box is reconnecting…')).toHaveClass('text-muted-foreground')
  expect(document.querySelector('.lucide-server-off')).toHaveClass('text-muted-foreground')
  expect(screen.getByRole('listitem')).toHaveAttribute('data-notice-kind', 'host')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  expect(screen.getByTestId('structured-composer')).toBeTruthy()

  setHost(hostStatus('verified', 'ready'))
  expect(screen.queryByText(/Build box/)).toBeNull()
  expect(screen.getByRole('list')).toBe(region)
})

it('says a disconnected host is offline at once and offers Reconnect', async () => {
  mocks.hasOlder = true
  renderPane()
  setHost(hostStatus('blocked', 'disconnected', true))

  expect(screen.getByText('Build box is offline')).toHaveClass('text-destructive')
  expect(document.querySelector('.lucide-server-off')).toHaveClass('text-destructive')
  expect(mocks.messageListProps?.session?.hasMore).toBe(false)

  reconnectHost.mockResolvedValue(true)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  })
  expect(reconnectHost).toHaveBeenCalledWith('remote-host')
  setHost(hostStatus('verified', 'ready'))
  expect(mocks.messageListProps?.session?.hasMore).toBe(true)
})

it('disables Reconnect until its attempt settles and allows another attempt after failure', async () => {
  let finish: (reachable: boolean) => void = () => {}
  reconnectHost.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
  )
  renderPane()
  setHost(hostStatus('blocked', 'disconnected', true))
  const reconnect = screen.getByRole('button', { name: 'Reconnect' })
  fireEvent.click(reconnect)
  expect(reconnect).toBeDisabled()
  fireEvent.click(reconnect)
  expect(reconnectHost).toHaveBeenCalledTimes(1)

  await act(async () => {
    finish(false)
  })
  expect(reconnect).toBeEnabled()
  expect(screen.getAllByText('Build box is offline')).toHaveLength(1)
  fireEvent.click(reconnect)
  expect(reconnectHost).toHaveBeenCalledTimes(2)
  await act(async () => {
    finish(true)
  })
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

it.each(['approval', 'question'] as const)(
  'keeps the empty %s notice region mounted when its first host row arrives',
  (kind) => {
    mocks.promptItems = [promptItem(kind)]
    renderPane()
    const region = screen.getByRole('list')
    expect(region.textContent).toBe('')
    expect(region).toHaveAttribute('aria-live', 'polite')
    setHost(hostStatus('blocked', 'disconnected', true))
    expect(screen.getByRole('list')).toBe(region)
    expect(region.textContent).toBe('Build box is offlineReconnect')
    expect(screen.getByRole('listitem')).toHaveAttribute('data-notice-kind', 'host')
    expect(screen.queryByRole('status')).toBeNull()
  }
)

it.each(['approval', 'question'] as const)(
  'keeps the host row and pending Reconnect when a %s takes the composer slot',
  async (kind) => {
    let finish: () => void = () => {}
    reconnectHost.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(false)
        })
    )
    const pane = renderPane()
    setHost(hostStatus('blocked', 'disconnected', true))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    mocks.promptItems = [promptItem(kind)]
    pane.rerender(paneElement())

    expect(screen.queryByTestId('structured-composer')).toBeNull()
    expect(document.querySelector(`[data-native-chat-${kind}-card-mock]`)).toBeTruthy()
    expect(screen.getAllByText('Build box is offline')).toHaveLength(1)
    expect(screen.getByRole('listitem')).toHaveAttribute('data-notice-kind', 'host')
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    const region = screen.getByRole('list')

    await act(async () => {
      finish()
    })
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
    setHost(hostStatus('verified', 'ready'))
    expect(screen.queryByText('Build box is offline')).toBeNull()
    expect(screen.getByRole('list')).toBe(region)
    expect(region).toHaveAttribute('aria-live', 'polite')
  }
)

it('says the outage once: a lost read beside messages adds no line of its own', () => {
  mocks.status = 'error'
  renderPane()
  setHost(hostStatus('blocked', 'disconnected'))

  expect(screen.getByTestId('message-list')).toBeTruthy()
  expect(screen.getByText('Build box is offline')).toBeTruthy()
  expect(screen.queryByText(/couldn't be loaded/)).toBeNull()
  expect(document.querySelectorAll('[data-notice-kind="host"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-notice-kind="error"]')).toHaveLength(0)
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
