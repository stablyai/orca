import { describe, expect, it, vi } from 'vitest'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'
import { makeState, titleResult } from './ai-vault-tab-title-test-fixture'

describe('AI Vault tab title sync', () => {
  it('never names a tab with the generated "<Agent> <id>" title (CR-title)', async () => {
    const store = makeState({
      agent: 'claude',
      executionHostId: 'runtime:server-1',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    // A failed first turn leaves the transcript with no title or prompt: the host answers the
    // generated name, "Claude" + the session id's first 8 characters.
    const resolveSessionTitles = vi.fn(async () => titleResult('claude', 'Claude claude-s'))
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })
    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle).toBeUndefined()
    stop()
  })
})
