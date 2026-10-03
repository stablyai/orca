// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
const mocks = vi.hoisted(() => ({
  supports: vi.fn<() => Promise<boolean>>(),
  rpc: vi.fn(),
  write: vi.fn(),
  row: ((): AgentStatusEntry | undefined => undefined)()
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ agentStatusByPaneKey: { pane: mocks.row } }) }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports,
  callRuntimeRpc: mocks.rpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: mocks.write,
  isRemoteRuntimePtyId: (id: string) => id.startsWith('remote:')
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn()
}))
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.row = {
    paneKey: 'pane',
    state: 'working',
    agentType: 'antigravity',
    prompt: 'private task',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    providerSession: { key: 'conversation_id', id: 'conversation' },
    observation: { authorityId: 'host', incarnation: 1, revision: 1, observedAt: 1, origin: 'hook' }
  }
  mocks.rpc.mockResolvedValue({ accepted: true, inferred: true })
})
afterEach(cleanup)

it('keeps the host working indicator and never writes to a legacy host', async () => {
  mocks.supports.mockResolvedValue(false)
  const { result } = renderHook(() =>
    useNativeChatInteractiveSend('tab', 'pane', 'remote:host@@term', 'antigravity')
  )
  expect(result.current.cancel()).toBe(false)
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
})

it('does not let a pending probe write after rebind or unmount', async () => {
  const probe = Promise.withResolvers<boolean>()
  mocks.supports.mockReturnValue(probe.promise)
  const { result, rerender, unmount } = renderHook(
    ({ ptyId }) => useNativeChatInteractiveSend('tab', 'pane', ptyId, 'antigravity'),
    {
      initialProps: { ptyId: 'remote:host@@old-term' }
    }
  )
  const oldCancel = result.current.cancel
  oldCancel()
  rerender({ ptyId: 'remote:host@@new-term' })
  expect(oldCancel()).toBe(false)
  unmount()
  await act(async () => {
    probe.resolve(true)
    await probe.promise
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
})

it('delegates one current cancellation to the paired host without local or legacy writes', async () => {
  mocks.supports.mockResolvedValue(true)
  const { result } = renderHook(() =>
    useNativeChatInteractiveSend('tab', 'pane', 'remote:host@@term', 'antigravity')
  )
  expect(result.current.cancel()).toBe(false)
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'host' },
    'nativeChat.interruptAntigravity',
    {
      terminal: 'term',
      providerSessionId: 'conversation',
      observation: { authorityId: 'host', incarnation: 1, revision: 1 }
    },
    { signal: expect.any(AbortSignal) }
  )
  expect(mocks.write).not.toHaveBeenCalled()
})
