import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createRestoredPromptCacheTimer } from './restored-prompt-cache-timer'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

describe('createRestoredPromptCacheTimer', () => {
  it("keeps waiting for a restored working Claude's hook row across spinner frames", () => {
    const timer = createRestoredPromptCacheTimer({
      paneKey: PANE_KEY,
      allowInitialIdleSeed: () => true,
      liveClaude: () => 'unread',
      setCacheTimerStartedAt: (key, entry) =>
        useAppStore.getState().setCacheTimerStartedAt(key, entry)
    })

    timer.restore('⠂ Claude Code')
    timer.observeTitle('⠐ Claude Code')
    useAppStore
      .getState()
      .setAgentStatus(PANE_KEY, { state: 'working', prompt: 'fix the bug', agentType: 'claude' })

    expect(useAppStore.getState().cacheTimerByKey[PANE_KEY]).toBe('requested')
    timer.dispose()
  })
})
