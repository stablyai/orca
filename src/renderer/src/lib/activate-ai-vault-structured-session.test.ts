import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const structuredSession = {
  structuredSession: { sessionId: 'session-1', workspaceId: 'workspace-1' }
} as AiVaultSession

function deps(overrides: Partial<Parameters<typeof activateAiVaultStructuredSession>[1]> = {}) {
  return {
    activate: vi.fn(() => true),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(async () => true),
    unavailable: vi.fn(),
    gone: vi.fn(),
    ...overrides
  }
}

describe('activateAiVaultStructuredSession', () => {
  it('refreshes an unpublished structured tab before activating it', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.refresh).toHaveBeenCalledWith('workspace-1')
    expect(parts.activate).toHaveBeenCalledTimes(2)
    // Why: the refresh alone answered, so the host was never asked to republish anything.
    expect(parts.reveal).not.toHaveBeenCalled()
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('reveals a session the inventory does not carry, then activates it', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.reveal).toHaveBeenCalledWith({
      worktreeId: 'workspace-1',
      sessionId: 'session-1'
    })
    // The refresh after the reveal is what carries the republished tab into the store.
    expect(parts.refresh).toHaveBeenCalledTimes(2)
    expect(parts.activate).toHaveBeenCalledTimes(3)
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('says the chat is gone rather than asking for a retry that cannot succeed', async () => {
    // Covers both terminal answers: the host refused, and the host cannot answer at all because it
    // does not advertise the reveal capability. Neither improves by waiting.
    const parts = deps({
      activate: vi.fn(() => false),
      reveal: vi.fn(async () => false)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.gone).toHaveBeenCalledOnce()
    expect(parts.unavailable).not.toHaveBeenCalled()
  })

  it('falls back to the retryable message when a revealed tab still does not arrive', async () => {
    const parts = deps({ activate: vi.fn(() => false) })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.reveal).toHaveBeenCalledOnce()
    expect(parts.unavailable).toHaveBeenCalledOnce()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('does not strand the click when the post-reveal refresh fails', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true),
      refresh: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('structured_session_restore_timeout'))
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    // The reveal already emitted a snapshot of its own, so a failed confirmation refresh must not
    // discard a tab that has in fact arrived.
    expect(parts.activate).toHaveBeenCalledTimes(3)
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('ignores a row that is not a structured chat', async () => {
    const parts = deps()

    await expect(activateAiVaultStructuredSession({} as AiVaultSession, parts)).resolves.toBe(false)

    expect(parts.reveal).not.toHaveBeenCalled()
  })
})
