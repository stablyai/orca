// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  store: null as null | {
    setState: (state: Record<string, unknown>) => void
  },
  subscribe: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    unifiedTabsByWorktree: {},
    testRuntimeOwner: null,
    setAgentStatus: vi.fn(),
    removeAgentStatus: vi.fn()
  }))
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

const historyResult = {
  ok: true,
  page: {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 1,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: null,
      newest: null,
      nextCursor: { epoch: 'epoch-1', sequence: 0 }
    },
    liveCursor: { epoch: 'epoch-1', sequence: 0 },
    hasOlder: false,
    hasNewer: false
  }
}

describe('StructuredAgentSessionStatusBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.call.mockResolvedValue(historyResult)
    mocks.subscribe.mockImplementation(async () => ({ unsubscribe: mocks.unsubscribe }))
    mocks.store?.setState({
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] },
      testRuntimeOwner: null
    })
  })

  afterEach(cleanup)

  it('rebinds a restored structured tab when its runtime owner hydrates', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    expect(mocks.subscribe.mock.calls[0]?.[0]).toEqual({ kind: 'local' })
    act(() => mocks.store?.setState({ testRuntimeOwner: 'env-1' }))

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.subscribe.mock.calls[1]?.[0]).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('reconnects after a graceful remote subscription close', async () => {
    mocks.store?.setState({ testRuntimeOwner: 'env-1' })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))

    const onClose = mocks.subscribe.mock.calls[0]?.[4] as (() => void) | undefined
    expect(onClose).toBeTypeOf('function')
    act(() => onClose?.())

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2), { timeout: 1_500 })
  })
})
