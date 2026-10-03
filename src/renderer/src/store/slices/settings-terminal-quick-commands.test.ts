import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES } from '../../../../shared/terminal-quick-command-prompt-limit'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

describe('quick-command saves from this client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refuses a list no host may store before writing anything, which covers the web client', async () => {
    const settingsSet = vi.fn()
    vi.stubGlobal('window', { api: { settings: { set: settingsSet } } })
    const store = createTestStore()

    await expect(
      store.getState().updateSettingsOrThrow({
        terminalQuickCommands: [
          {
            id: 'review',
            label: 'review',
            action: 'agent-prompt',
            agent: 'claude',
            prompt: 'x'.repeat(MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES),
            scope: { type: 'global' }
          }
        ]
      })
    ).rejects.toThrow(/Quick command prompts can be up to/)
    expect(settingsSet).not.toHaveBeenCalled()
  })
})
