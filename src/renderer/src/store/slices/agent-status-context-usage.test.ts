import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

describe('agent status contextUsage', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a contextUsage reading onto the entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: { usedTokens: 120_000, maxTokens: 200_000 }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toEqual({
      usedTokens: 120_000,
      maxTokens: 200_000
    })
  })

  it('carries the cached reading across pings that omit contextUsage (unlike tool fields)', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: { usedTokens: 120_000 }
    })
    // Why: hook tool-use pings never carry usage — dropping it here would make the indicator flicker per ping.
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toEqual({
      usedTokens: 120_000
    })
  })

  it('reuses the previous object reference when a repeat reading is structurally equal', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const reading = { usedTokens: 120_000, maxTokens: 200_000 }
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: reading
    })
    const first = store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: { ...reading }
    })
    // Why: identity-comparing subscribers must not re-render on unchanged usage pings.
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toBe(first)
  })

  it('clears the cached reading on an explicit null', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: { usedTokens: 120_000 }
    })
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'p2',
      agentType: 'claude',
      contextUsage: null
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toBeNull()
  })

  it('drops the cached reading when the pane is reused by a different agent type', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'done',
      prompt: 'p1',
      agentType: 'claude',
      contextUsage: { usedTokens: 120_000 }
    })
    // Why: usage belongs to the provider session; a different agent in the same pane must not inherit it.
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'codex' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toBeUndefined()
  })

  it('drops the cached reading when the provider session changes', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'working',
        prompt: 'p1',
        agentType: 'claude',
        contextUsage: { usedTokens: 120_000 }
      },
      undefined,
      undefined,
      undefined,
      { providerSession: { key: 'session_id', id: 'session-1' } }
    )
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'p2', agentType: 'claude' },
        undefined,
        undefined,
        undefined,
        { providerSession: { key: 'session_id', id: 'session-2' } }
      )

    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toBeUndefined()
  })

  it('drops the cached reading when a done pane starts a new session', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'done',
      prompt: 'old task',
      agentType: 'claude',
      contextUsage: { usedTokens: 120_000 }
    })
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'new task',
      agentType: 'claude'
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:1'].contextUsage).toBeUndefined()
  })
})
