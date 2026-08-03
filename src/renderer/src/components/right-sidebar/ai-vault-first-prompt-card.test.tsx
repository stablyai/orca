// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstPromptCard } from './ai-vault-first-prompt-card'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

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
    // StrictMode mounts, cleans up, then re-mounts. The cleanup marks the first
    // request stale, so only a fresh second request can clear `loading`.
    stubApi(vi.fn().mockResolvedValue({ prompt: 'Ship the copy button' }))

    render(
      <StrictMode>
        <FirstPromptCard session={session} previewText="" />
      </StrictMode>
    )

    await waitFor(() => expect(screen.getByText('Ship the copy button')).toBeTruthy())
    expect(screen.queryByText('Loading first prompt…')).toBeNull()
  })

  it('stops loading when the read never settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // A main process that never answers must not pin the card in `loading`.
    stubApi(vi.fn().mockReturnValue(new Promise(() => {})))

    render(<FirstPromptCard session={session} previewText="" />)

    expect(screen.getByText('Loading first prompt…')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(15_000)
    await waitFor(() => expect(screen.getByText('No first prompt available')).toBeTruthy())
    expect(screen.queryByText('Loading first prompt…')).toBeNull()
  })
})
