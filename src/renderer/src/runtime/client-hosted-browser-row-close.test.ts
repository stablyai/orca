import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeClientHostedBrowserRow } from './client-hosted-browser-row-close'

const call = vi.fn()

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue({ ok: true, result: { closed: true } })
  vi.stubGlobal('window', { api: { runtime: { call } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('closeClientHostedBrowserRow', () => {
  // The host’s own registry owns this page despite paired-client rendering; environment routing would close nothing.
  it('closes the page through the local runtime by worktree and page id', async () => {
    await closeClientHostedBrowserRow({
      worktreeId: 'repo-1::/tmp/worktree-a',
      browserPageId: 'page-a'
    })

    expect(call).toHaveBeenCalledWith({
      method: 'browser.tabClose',
      params: { worktree: 'id:repo-1::/tmp/worktree-a', page: 'page-a' }
    })
  })

  it('surfaces a refused close instead of reporting success', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'browser_error', message: 'nope' } })

    await expect(
      closeClientHostedBrowserRow({ worktreeId: 'wt-1', browserPageId: 'page-a' })
    ).rejects.toThrow(/nope/)
  })
})
