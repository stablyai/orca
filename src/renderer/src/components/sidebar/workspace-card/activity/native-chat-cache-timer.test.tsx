// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../../shared/agent-session/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const state: { store: TestStore | null; subscribeStatus: Mock } = {
    store: null,
    subscribeStatus: vi.fn()
  }
  return state
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ? `runtime:${state.testRuntimeOwner}` : 'local'
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

import { StructuredAgentSessionStatusBridge } from '@/components/native-chat/session/status/StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useAppStore } from '@/store'
import CacheTimer, {
  usePromptCacheCountdownForPane,
  usePromptCacheCountdownStartedAt
} from './CacheTimer'

const NOW = 1_800_000
const PANE_KEY = 'terminal-1:00000000-0000-4000-8000-000000000001'
const tab = {
  id: 'chat-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Claude chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  agentSessionAgent: 'claude'
} satisfies Tab

function store(): TestStore {
  if (!mocks.store) {
    throw new Error('Test store not initialized')
  }
  return mocks.store
}

function configureTimer(enabled: boolean, ttlMs = 300_000): void {
  act(() =>
    store().setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        promptCacheTimerEnabled: enabled,
        promptCacheTtlMs: ttlMs
      }
    })
  )
}

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'idle',
    latestPrompt: 'Explain the result',
    updatedAt: 1_680_000,
    statusStartedAt: 1_680_000,
    ...overrides
  }
}

function Countdown({ paneKey }: { paneKey?: string }) {
  const pane = usePromptCacheCountdownForPane(paneKey ?? '', paneKey !== undefined)
  const aggregate = usePromptCacheCountdownStartedAt('wt-1', paneKey === undefined)
  const startedAt = paneKey === undefined ? aggregate : (pane?.startedAt ?? null)
  const configuredTtlMs = useAppStore((state) => state.settings?.promptCacheTtlMs ?? 0)
  const ttlMs = paneKey === undefined ? configuredTtlMs : (pane?.ttlMs ?? 0)
  return (
    <div data-testid={paneKey ? 'session-countdown' : 'workspace-countdown'}>
      {startedAt !== null && <CacheTimer startedAt={startedAt} ttlMs={ttlMs} />}
    </div>
  )
}

async function connect(): Promise<(event: AgentSessionStatusEvent) => void> {
  render(
    <TooltipProvider>
      <StructuredAgentSessionStatusBridge />
      <Countdown paneKey={structuredAgentSessionPaneKey(tab.id, tab.entityId)} />
      <Countdown />
    </TooltipProvider>
  )
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  const emit: (event: AgentSessionStatusEvent) => void = mocks.subscribeStatus.mock.calls[0][1]
  return (event) => act(() => emit(event))
}

describe.each(['local', 'remote'])('%s native Claude cache countdown', (host) => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: vi.fn() })
    store().setState({
      settings: { ...getDefaultSettings('/tmp'), promptCacheTimerEnabled: true },
      testRuntimeOwner: host === 'remote' ? 'host-1' : null,
      agentStatusByPaneKey: {},
      unifiedTabsByWorktree: { 'wt-1': [tab] },
      tabsByWorktree: {},
      cacheTimerByKey: {}
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.restoreAllMocks()
  })

  it('shows the settled turn on restore, preserves its age, and clears it while working', async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary()] })
    expect(screen.getByTestId('session-countdown').textContent).toBe('3:00')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('3:00')

    emit({
      type: 'status',
      session: summary({
        updatedAt: NOW,
        backgroundTasks: [{ id: 'child-1', kind: 'agent', state: 'working' }]
      })
    })
    expect(screen.getByTestId('session-countdown').textContent).toBe('3:00')

    act(() => {
      store().setState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'terminal-1',
              worktreeId: 'wt-1',
              ptyId: null,
              title: 'Claude',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        cacheTimerByKey: { [PANE_KEY]: 1_740_000 }
      })
    })
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('3:00')

    emit({ type: 'status', session: summary({ status: 'working', updatedAt: NOW }) })
    expect(screen.getByTestId('session-countdown').textContent).toBe('')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('4:00')

    emit({ type: 'status', session: summary({ statusStartedAt: 1_770_000, updatedAt: NOW }) })
    expect(screen.getByTestId('session-countdown').textContent).toBe('4:30')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('4:00')

    configureTimer(false)
    expect(screen.getByTestId('session-countdown').textContent).toBe('')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('')
    configureTimer(true)
    expect(screen.getByTestId('session-countdown').textContent).toBe('4:30')

    configureTimer(true, 3_600_000)
    expect(screen.getByTestId('session-countdown').textContent).toBe('59:30')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('59:00')

    act(() => store().setState({ unifiedTabsByWorktree: {} }))
    expect(screen.getByTestId('session-countdown').textContent).toBe('')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('59:00')
  })

  it('keeps fresh chats and other providers untimed and accepts older host summaries', async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary({ status: null })] })
    expect(screen.getByTestId('session-countdown').textContent).toBe('')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('')
    emit({
      type: 'status',
      session: summary({ statusStartedAt: undefined, hostExecutionOwned: undefined })
    })
    expect(screen.getByTestId('session-countdown').textContent).toBe('3:00')
    emit({
      type: 'status',
      session: summary({
        latestPrompt: '',
        lastAssistantMessage: undefined,
        turnOutcome: 'success'
      })
    })
    expect(screen.getByTestId('session-countdown').textContent).toBe('3:00')
    act(() => {
      store().setState({
        unifiedTabsByWorktree: { 'wt-1': [{ ...tab, agentSessionAgent: 'codex' }] }
      })
    })
    expect(screen.getByTestId('session-countdown').textContent).toBe('')
    expect(screen.getByTestId('workspace-countdown').textContent).toBe('')
  })
})
