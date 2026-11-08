import { describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'

const FIRST: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
const SECOND: AiVaultListResult = { ...FIRST, scannedAt: '2026-08-09T00:00:01.000Z' }

describe('AiVaultSessionPublicationGate', () => {
  // A chat-link snapshot right after a restart cancels the gate; it must not drop the saved list.
  it('shows a late saved list after a cancel but never over a newer published list', async () => {
    const shown = vi.fn()
    const gate = new AiVaultSessionPublicationGate()
    gate.showUntilPublished(Promise.resolve(FIRST), shown)
    gate.cancel()
    await Promise.resolve()
    expect(shown).toHaveBeenCalledWith(FIRST)

    const late = vi.fn()
    gate.showUntilPublished(Promise.resolve(FIRST), late)
    gate.publish(SECOND, vi.fn())
    await Promise.resolve()
    expect(late).not.toHaveBeenCalled()
  })
})
