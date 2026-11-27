import { describe, expect, it, vi } from 'vitest'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'
import { makeState } from './ai-vault-tab-title-test-fixture'

describe('AI Vault tab title sync', () => {
  // Older hosts named /clear's transcript with its command caveat, and tabs saved it.
  it('drops a saved harness-markup title even when an older host still returns it', async () => {
    const caveatTitle = {
      agent: 'claude' as const,
      sessionId: 'claude-session',
      title: '<local-command-caveat>The command below was run directly in Claude Code...',
      kind: 'fallback' as const
    }
    const store = makeState({
      agent: 'claude',
      aiVaultTitle: caveatTitle,
      executionHostId: 'local',
      path: '/repo',
      sleeping: true,
      worktreeId: 'wt-1'
    })
    const resolveSessionTitles = vi.fn(async () => ({ titles: [caveatTitle] }))
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: (listener) =>
        store.subscribe((next, previous) => listener(next, previous, new Map(), new Map())),
      readStatuses: () => new Map(),
      resolveSessionTitles
    })
    try {
      await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalled())
      expect(store.getState().tabsByWorktree['wt-1'][0].aiVaultTitle).toBeNull()
    } finally {
      stop()
    }
  })
})
