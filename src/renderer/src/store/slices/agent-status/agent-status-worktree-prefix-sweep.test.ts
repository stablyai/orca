import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState } from '../../types'

import { createTestStore } from '../../testing/app-store-test-fixture'
import '../../../i18n/i18n'

describe('worktree agent status cleanup', () => {
  // Use fake timers: setAgentStatus schedules a real 30-minute timer through queueMicrotask.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dropAgentStatusByWorktree removes live entries attributed before their tab exists', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const paneKey = 'tab-worker:11111111-1111-4111-8111-111111111111'

    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'worker', agentType: 'codex' },
        undefined,
        undefined,
        {
          tabId: 'tab-worker',
          worktreeId: 'wt-a',
          terminalHandle: 'term-worker'
        }
      )
    store.setState({
      acknowledgedAgentsByPaneKey: { [paneKey]: Date.now() }
    } as Partial<AppState>)

    store.getState().dropAgentStatusByWorktree('wt-a')

    expect(store.getState().agentStatusByPaneKey.get(paneKey)).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()
  })
})
