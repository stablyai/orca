import { describe, expect, it, vi } from 'vitest'

const opener = vi.hoisted(() => ({
  getLspClient: vi.fn(),
  retainLspClient: vi.fn(),
  releaseLspClient: vi.fn()
}))
vi.mock('./lsp-session-opener', () => opener)

import { lookupWorkspaceSymbol } from './lsp-workspace-symbol-lookup'

describe('lookupWorkspaceSymbol', () => {
  it('releases each client lease after the lookup, even when the request fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('boom'))
    opener.getLspClient.mockResolvedValue({ request })
    await lookupWorkspaceSymbol('wt', 'Foo')
    for (const languageId of ['typescript', 'ruby']) {
      expect(opener.retainLspClient).toHaveBeenCalledWith('wt', languageId)
      expect(opener.releaseLspClient).toHaveBeenCalledWith('wt', languageId)
    }
    expect(opener.retainLspClient.mock.invocationCallOrder[0]).toBeLessThan(
      opener.getLspClient.mock.invocationCallOrder[0]
    )
    expect(Math.min(...opener.releaseLspClient.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...request.mock.invocationCallOrder)
    )
  })
})
