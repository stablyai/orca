import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState } from '../types'
import { createTestStore } from './store-test-helpers'

describe('agent status cleanup for a lost SSH connection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clears one connection in one update while preserving newer and unstamped rows', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const oldA = 'tab-a:11111111-1111-4111-8111-111111111111'
    const secondA = 'tab-a2:22222222-2222-4222-8222-222222222222'
    const newerA = 'tab-new:33333333-3333-4333-8333-333333333333'
    const siblingB = 'tab-b:44444444-4444-4444-8444-444444444444'
    const unstamped = 'tab-legacy:55555555-5555-4555-8555-555555555555'
    for (const [paneKey, updatedAt, connectionId] of [
      [oldA, 10, 'ssh-a'],
      [secondA, 20, 'ssh-a'],
      [newerA, 31, 'ssh-a'],
      [siblingB, 15, 'ssh-b']
    ] as const) {
      store
        .getState()
        .setAgentStatus(
          paneKey,
          { state: 'working', prompt: paneKey, agentType: 'codex' },
          undefined,
          { updatedAt },
          { connectionId }
        )
    }
    store
      .getState()
      .setAgentStatus(
        unstamped,
        { state: 'working', prompt: 'legacy', agentType: 'claude' },
        undefined,
        { updatedAt: 5 }
      )
    store.setState({
      agentLaunchConfigByPaneKey: {
        [oldA]: {
          launchConfig: { agentCommand: 'codex', agentArgs: '--full-auto', agentEnv: {} },
          registeredAt: 1,
          identity: {}
        }
      },
      acknowledgedAgentsByPaneKey: { [oldA]: 2 },
      retentionSuppressedPaneKeys: { [oldA]: true }
    } as Partial<AppState>)
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {})

    store.getState().clearTransientAgentStatuses('ssh-a', 30)

    unsubscribe()
    expect(subscriber).toHaveBeenCalledOnce()
    expect(queueMicrotaskSpy).toHaveBeenCalledOnce()
    expect(store.getState().agentStatusByPaneKey[oldA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[secondA]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[newerA]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[siblingB]).toBeDefined()
    expect(store.getState().agentStatusByPaneKey[unstamped]).toBeDefined()
    expect(store.getState().agentLaunchConfigByPaneKey[oldA]).toBeDefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[oldA]).toBe(2)
    expect(store.getState().retentionSuppressedPaneKeys[oldA]).toBe(true)
  })

  it('retains an accepted connection stamp across later unstamped pings', () => {
    const store = createTestStore()
    const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'first', agentType: 'codex' },
        undefined,
        { updatedAt: 1 },
        { connectionId: 'ssh-a' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'ping', agentType: 'codex' },
        undefined,
        { updatedAt: 2 }
      )

    expect(store.getState().agentStatusByPaneKey[paneKey]?.connectionId).toBe('ssh-a')
  })
})
