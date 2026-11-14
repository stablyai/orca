import { describe, expect, it, vi } from 'vitest'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'
import { makeState, titleResult } from './ai-vault-tab-title-test-fixture'

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
  }
}

describe('Antigravity tab title sync', () => {
  it('resolves a sleeping Antigravity session title', async () => {
    const store = makeState({
      agent: 'antigravity',
      executionHostId: 'local',
      path: '/workspace/app',
      worktreeId: 'wt-1',
      sleeping: true
    })
    const resolveSessionTitles = vi
      .fn()
      .mockResolvedValue(titleResult('antigravity', 'Refactor Session Title Sync', 'named'))

    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      resolveSessionTitles,
      subscribe: store.subscribe,
      setTimer: () => 1,
      clearTimer: () => {}
    })
    try {
      await flushMicrotasks()
      expect(resolveSessionTitles).toHaveBeenCalledTimes(1)
      expect(store.getState().tabsByWorktree['wt-1'][0]?.aiVaultTitle).toEqual({
        agent: 'antigravity',
        sessionId: 'antigravity-session',
        title: 'Refactor Session Title Sync',
        kind: 'named'
      })
    } finally {
      stop()
    }
  })

  it('performs one final refresh when a live fallback session transitions to sleeping', async () => {
    const store = makeState({
      agent: 'antigravity',
      executionHostId: 'local',
      path: '/workspace/app',
      worktreeId: 'wt-1',
      sleeping: false
    })
    const paneKey = 'tab-1:00000000-0000-4000-8000-000000000001'
    const providerSession = store.getState().agentStatusByPaneKey[paneKey]?.providerSession
    if (!providerSession) {
      throw new Error('Expected fixture providerSession')
    }
    const setTimer = vi.fn(() => 1)
    const resolveSessionTitles = vi
      .fn()
      .mockResolvedValueOnce(titleResult('antigravity', 'Draft launch plan', 'fallback'))
      .mockResolvedValueOnce(titleResult('antigravity', 'Refactor Session Title Sync', 'named'))

    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      resolveSessionTitles,
      subscribe: store.subscribe,
      setTimer,
      clearTimer: () => {}
    })
    try {
      await flushMicrotasks()
      expect(store.getState().tabsByWorktree['wt-1'][0]?.aiVaultTitle).toEqual({
        agent: 'antigravity',
        sessionId: 'antigravity-session',
        title: 'Draft launch plan',
        kind: 'fallback'
      })

      setTimer.mockClear()
      store.update({
        agentStatusByPaneKey: {},
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'antigravity',
            providerSession,
            prompt: '',
            state: 'done',
            capturedAt: 2,
            updatedAt: 2,
            origin: 'worktree-sleep'
          }
        }
      })
      await flushMicrotasks()

      expect(resolveSessionTitles).toHaveBeenCalledTimes(2)
      expect(setTimer).not.toHaveBeenCalled()
      expect(store.getState().tabsByWorktree['wt-1'][0]?.aiVaultTitle).toEqual({
        agent: 'antigravity',
        sessionId: 'antigravity-session',
        title: 'Refactor Session Title Sync',
        kind: 'named'
      })
    } finally {
      stop()
    }
  })
})
