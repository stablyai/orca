import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const structuredSession = {
  structuredSession: { sessionId: 'session-1', workspaceId: 'workspace-1' }
} as AiVaultSession

describe('activateAiVaultStructuredSession', () => {
  it('refreshes an unpublished structured tab before activating it', async () => {
    const activate = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const refresh = vi.fn(async () => undefined)
    const unavailable = vi.fn()

    await expect(
      activateAiVaultStructuredSession(structuredSession, { activate, refresh, unavailable })
    ).resolves.toBe(true)

    expect(refresh).toHaveBeenCalledWith('workspace-1')
    expect(activate).toHaveBeenCalledTimes(2)
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('surfaces a retryable state when the structured tab remains unavailable', async () => {
    const activate = vi.fn(() => false)
    const refresh = vi.fn(async () => undefined)
    const unavailable = vi.fn()

    await expect(
      activateAiVaultStructuredSession(structuredSession, { activate, refresh, unavailable })
    ).resolves.toBe(true)

    expect(activate).toHaveBeenCalledTimes(2)
    expect(unavailable).toHaveBeenCalledOnce()
  })
})
