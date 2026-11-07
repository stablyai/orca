// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstPromptCard } from './ai-vault-first-prompt-card'

import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

const session = {
  id: 'local:claude:s1:/repo/session.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 's1',
  filePath: '/repo/session.jsonl',
  codexHome: null
} as unknown as AiVaultSession

function stubApi(getFirstUserPrompt: unknown): void {
  ;(window as unknown as { api: unknown }).api = {
    aiVault: { getFirstUserPrompt },
    ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FirstPromptCard', () => {
  it('resolves loading under StrictMode double-invoke instead of stranding the card', async () => {
    // StrictMode cleanup stales the first request; only a fresh second request can clear loading.
    stubApi(vi.fn().mockResolvedValue({ prompt: 'Ship the copy button' }))

    render(
      <StrictMode>
        <FirstPromptCard session={session} preview={null} />
      </StrictMode>
    )

    await waitFor(() => expect(screen.getByText('Ship the copy button')).toBeTruthy())
    expect(screen.queryByText('Loading first prompt…')).toBeNull()
  })
})
