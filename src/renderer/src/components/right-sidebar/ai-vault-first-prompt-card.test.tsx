// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstPromptCard } from './ai-vault-first-prompt-card'
import { sessionPromptPreview } from './ai-vault-session-display'
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
  it('labels stored firstUserPrompt text as the first prompt', () => {
    const remoteSession = {
      ...session,
      executionHostId: 'ssh:dev-box',
      firstUserPrompt: 'The authoritative opening ask'
    } as AiVaultSession
    stubApi(vi.fn().mockResolvedValue({ prompt: null }))

    render(
      <FirstPromptCard session={remoteSession} preview={sessionPromptPreview(remoteSession)} />
    )

    expect(screen.getByText('First prompt')).toBeTruthy()
    expect(screen.getByText('The authoritative opening ask')).toBeTruthy()
  })

  it('labels a remote preview fallback as a recent prompt when no full read is available', () => {
    const getFirstUserPrompt = vi.fn().mockResolvedValue({ prompt: null })
    const remoteSession = {
      ...session,
      executionHostId: 'ssh:dev-box',
      previewMessagesTruncated: true,
      previewMessages: [
        { role: 'user', text: 'A recent ask from the sliding window', timestamp: null }
      ]
    } as AiVaultSession
    stubApi(getFirstUserPrompt)

    render(
      <FirstPromptCard session={remoteSession} preview={sessionPromptPreview(remoteSession)} />
    )

    expect(screen.getByText('Recent prompt')).toBeTruthy()
    expect(screen.getByText('A recent ask from the sliding window')).toBeTruthy()
    expect(getFirstUserPrompt).not.toHaveBeenCalled()
  })

  it('relabels a local preview fallback after the full first prompt loads', async () => {
    const localSession = {
      ...session,
      previewMessagesTruncated: true,
      previewMessages: [
        { role: 'user', text: 'A recent ask from the sliding window', timestamp: null }
      ]
    } as AiVaultSession
    stubApi(vi.fn().mockResolvedValue({ prompt: 'The authoritative opening ask' }))

    render(<FirstPromptCard session={localSession} preview={sessionPromptPreview(localSession)} />)

    expect(screen.getByText('Recent prompt')).toBeTruthy()
    expect(screen.getByText('A recent ask from the sliding window')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('First prompt')).toBeTruthy())
    expect(screen.getByText('The authoritative opening ask')).toBeTruthy()
  })

  it('resolves loading under StrictMode double-invoke instead of stranding the card', async () => {
    // StrictMode mounts, cleans up, then re-mounts. The cleanup marks the first
    // request stale, so only a fresh second request can clear `loading`.
    stubApi(vi.fn().mockResolvedValue({ prompt: 'Ship the copy button' }))

    render(
      <StrictMode>
        <FirstPromptCard session={session} preview={null} />
      </StrictMode>
    )

    await waitFor(() => expect(screen.getByText('Ship the copy button')).toBeTruthy())
    expect(screen.queryByText('Loading first prompt…')).toBeNull()
  })

  it('stops loading when the read never settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // A main process that never answers must not pin the card in `loading`.
    stubApi(vi.fn().mockReturnValue(new Promise(() => {})))

    render(<FirstPromptCard session={session} preview={null} />)

    expect(screen.getByText('Loading first prompt…')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(15_000)
    await waitFor(() => expect(screen.getByText('No first prompt available')).toBeTruthy())
    expect(screen.queryByText('Loading first prompt…')).toBeNull()
  })
})
