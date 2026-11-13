// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const reconnectHost = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () =>
  moduleFactories.structuredAgentSessionCall()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () =>
  moduleFactories.structuredAgentSessionSubscriptions()
)
vi.mock('../../session/structured/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../../appearance/use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('../../links/actions/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../links/actions/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('../../composer/NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('../../prompts/NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('../../prompts/NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reconnectHost
}))

import { useAppStore } from '@/store'
import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'

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
