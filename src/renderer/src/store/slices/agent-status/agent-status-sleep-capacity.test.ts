import { afterEach, expect, it, vi } from 'vitest'
import { acceptedAgentStatuses } from './accepted-agent-statuses'
import { createTestStore } from '../../testing/app-store-test-fixture'

const KEY = 'tab:11111111-1111-4111-8111-111111111111'
afterEach(() => vi.restoreAllMocks())

it('keeps sleeping capacity consistent across wake, aborted writes, capture and reset', () => {
  const store = createTestStore()
  const done = {
    paneKey: KEY,
    state: 'done' as const,
    prompt: 'Finished',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    paneSleep: { ptyId: 'ended' }
  }
  store.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[KEY, done]]) })
  const captured = store.getState().agentStatusByPaneKey.capture()
  expect(() =>
    store.getState().transactAgentStatuses((transaction) => {
      transaction.apply({ paneKey: KEY, payload: { state: 'working', prompt: 'Wake' } })
      expect(transaction.getState().agentStatusByPaneKey.awakeSize).toBe(1)
      throw new Error('abort wake')
    })
  ).toThrow('abort wake')
  expect(store.getState().agentStatusByPaneKey.get(KEY)).toBe(done)
  expect(store.getState().agentStatusByPaneKey.awakeSize).toBe(0)
  store.getState().setAgentStatus(KEY, { state: 'working', prompt: 'Wake' })
  expect(store.getState().agentStatusByPaneKey.awakeSize).toBe(1)
  store.setState({
    agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([
      [KEY, null],
      [KEY, done]
    ])
  })
  expect(store.getState().agentStatusByPaneKey.size).toBe(1)
  expect(store.getState().agentStatusByPaneKey.awakeSize).toBe(0)
  store.setState({ agentStatusByPaneKey: acceptedAgentStatuses() })
  expect(store.getState().agentStatusByPaneKey.size).toBe(0)
  expect(store.getState().agentStatusByPaneKey.awakeSize).toBe(0)
  expect(captured.get(KEY)).toBe(done)
  expect(captured.size).toBe(1)
  expect(captured.awakeSize).toBe(0)
})
