// @vitest-environment happy-dom
import type * as OriginalModule0 from '@/runtime/structured-conversation-name'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'

const mocks = vi.hoisted(() => ({ renders: vi.fn(), feed: vi.fn() }))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: () => null
}))
vi.mock('@/runtime/structured-conversation-name', async (original) => {
  const actual = await original<typeof OriginalModule0>()
  return {
    ...actual,
    useStructuredChatTabConversationName: (tab: Tab | undefined) => {
      mocks.renders(tab?.id)
      return actual.useStructuredChatTabConversationName(tab)
    }
  }
})
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: mocks.feed
}))
const initial = useAppStore.getState()
const names = new Map()
const feed = { subscribe: () => () => {}, activate: () => () => {}, getNamingSnapshot: () => names }
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

it.each([100, 1000])(
  'indexes %s retained chat tabs once and isolates store writes from renders',
  async (count) => {
    mocks.feed.mockReturnValue(feed)
    let reads = 0
    const tabs: Tab[] = Array.from({ length: count }, (_, index) => ({
      id: `tab-${index}`,
      entityId: `session-${index}`,
      contentType: 'agent-session',
      groupId: 'group',
      worktreeId: 'folder',
      label: `Chat ${index}`,
      customLabel: null,
      color: null,
      sortOrder: index,
      createdAt: 1,
      executionHostId: 'runtime:a'
    }))
    function watched(values: Tab[]) {
      return new Proxy(values, {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads += 1
          }
          // SAFETY: the proxy preserves array reads while counting the production selector's iteration.
          // oxlint-disable-next-line anti-slop/no-reflect-get
          return Reflect.get(target, key)
        }
      })
    }
    const array = watched(tabs)
    useAppStore.setState({
      settings: getDefaultSettings('/test'),
      unifiedTabsByWorktree: { folder: array }
    })
    render(
      <>
        {tabs.map((tab) => (
          <NativeChatUsageLimitActionsProvider
            key={tab.id}
            pane={{
              tabId: tab.id,
              sessionId: tab.entityId,
              agent: 'claude',
              target: { kind: 'environment', environmentId: 'a' },
              isVisible: false,
              isFocusedGroup: false
            }}
            directory={{ worktreeId: 'folder', worktreePath: '/work', runtimeEnvironmentId: 'a' }}
            recovery={{ readCurrent: true, canSwitchAccount: true }}
            messages={[]}
            view={{
              hostLabel: null,
              remoteHost: true,
              continueAvailable: false,
              offeredTurnItemId: null,
              continueNow: () => {},
              usageLimitTurnItemId: null,
              continueUsageLimit: () => {}
            }}
          >
            {null}
          </NativeChatUsageLimitActionsProvider>
        ))}
      </>
    )
    await act(async () => {})
    expect(reads).toBe(count)
    reads = 0
    mocks.renders.mockClear()
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'other' }
      }))
    )
    await act(async () =>
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, other: [] }
      }))
    )
    expect(reads).toBe(0)
    expect(mocks.renders).not.toHaveBeenCalled()
    const renamed: Tab = { ...tabs[0]!, customLabel: 'Renamed', executionHostId: 'runtime:b' }
    await act(async () =>
      useAppStore.setState({
        unifiedTabsByWorktree: { folder: watched([renamed, ...tabs.slice(1)]) }
      })
    )
    expect(reads).toBe(count)
    expect(mocks.renders.mock.calls.length).toBeGreaterThan(0)
    expect(mocks.renders.mock.calls.every(([id]) => id === renamed.id)).toBe(true)
    expect(mocks.feed).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'b' })
    reads = 0
    mocks.renders.mockClear()
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'again' }
      }))
    )
    expect(reads).toBe(0)
    expect(mocks.renders).not.toHaveBeenCalled()
  }
)
