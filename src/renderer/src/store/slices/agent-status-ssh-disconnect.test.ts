import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('agent status cleanup on SSH disconnect', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes only live entries for the affected worktree and is idempotent', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const targetPane = 'tab-remote:11111111-1111-4111-8111-111111111111'
    const attributedPane = 'tab-worker:22222222-2222-4222-8222-222222222222'
    const otherPane = 'tab-other:33333333-3333-4333-8333-333333333333'
    store.setState({
      tabsByWorktree: {
        'wt-remote': [makeTab({ id: 'tab-remote', worktreeId: 'wt-remote' })],
        'wt-other': [makeTab({ id: 'tab-other', worktreeId: 'wt-other' })]
      },
      acknowledgedAgentsByPaneKey: { [targetPane]: 123 },
      retentionSuppressedPaneKeys: { [targetPane]: true }
    } as Partial<AppState>)
    store
      .getState()
      .setAgentStatus(targetPane, { state: 'working', prompt: 'remote', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus(
        attributedPane,
        { state: 'waiting', prompt: 'worker', agentType: 'claude' },
        undefined,
        undefined,
        { worktreeId: 'wt-remote', tabId: 'tab-worker' }
      )
    store
      .getState()
      .setAgentStatus(otherPane, { state: 'working', prompt: 'other', agentType: 'codex' })
    store.setState({
      agentLaunchConfigByPaneKey: {
        [targetPane]: {
          launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
          registeredAt: 123,
          identity: {}
        }
      },
      acknowledgedAgentsByPaneKey: { [targetPane]: 123 },
      retentionSuppressedPaneKeys: { [targetPane]: true }
    } as Partial<AppState>)

    store.getState().removeAgentStatusByWorktree('wt-remote')
    const epochAfterFirstRemoval = store.getState().agentStatusEpoch

    expect(store.getState().agentStatusByPaneKey[targetPane]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[attributedPane]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[otherPane]).toBeDefined()
    expect(store.getState().agentLaunchConfigByPaneKey[targetPane]).toMatchObject({
      launchConfig: { agentCommand: 'codex' },
      registeredAt: 123
    })
    expect(store.getState().acknowledgedAgentsByPaneKey[targetPane]).toBe(123)
    expect(store.getState().retentionSuppressedPaneKeys).toEqual({ [targetPane]: true })

    store.getState().removeAgentStatusByWorktree('wt-remote')
    expect(store.getState().agentStatusEpoch).toBe(epochAfterFirstRemoval)
    expect(store.getState().agentStatusByPaneKey[otherPane]).toBeDefined()
  })

  it('removes one transient status without retiring its pane metadata', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const paneKey = 'tab-remote:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(paneKey, { state: 'working', prompt: 'remote', agentType: 'codex' })
    store.setState({
      agentLaunchConfigByPaneKey: {
        [paneKey]: {
          launchConfig: { agentCommand: 'codex', agentArgs: '--full-auto', agentEnv: {} },
          registeredAt: 123,
          identity: {}
        }
      },
      acknowledgedAgentsByPaneKey: { [paneKey]: 456 },
      retentionSuppressedPaneKeys: { [paneKey]: true }
    } as Partial<AppState>)

    store.getState().removeTransientAgentStatus(paneKey)
    const epochAfterRemoval = store.getState().agentStatusEpoch

    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().agentLaunchConfigByPaneKey[paneKey]).toMatchObject({
      launchConfig: { agentCommand: 'codex', agentArgs: '--full-auto' },
      registeredAt: 123
    })
    expect(store.getState().acknowledgedAgentsByPaneKey[paneKey]).toBe(456)
    expect(store.getState().retentionSuppressedPaneKeys[paneKey]).toBe(true)

    store.getState().removeTransientAgentStatus(paneKey)
    expect(store.getState().agentStatusEpoch).toBe(epochAfterRemoval)
  })
})
