import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runIssueUpdate } from './github-work-item-edit-mutations'

import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn(() => ({ repos: [] })) } }))
vi.mock('@/components/github/github-work-item-comment-mutations', () => ({
  notifyWorkItemDetailsMutation: vi.fn()
}))

const ORIGIN = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }

describe('issue edits retain the displayed repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(callRuntimeRpc).mockResolvedValue({ ok: true })
    vi.stubGlobal('window', {
      api: {
        gh: { updateIssue: vi.fn().mockResolvedValue({ ok: true }), updateIssueBySlug: vi.fn() }
      }
    })
  })

  it.each([
    { state: 'closed' as const },
    { addLabels: ['bug'] },
    { addAssignees: ['fork-assignee'] }
  ])('pins field edits to the opened issue repository: %j', async (updates) => {
    await runIssueUpdate({
      repoPath: 'C:\\workspace\\widgets',
      repoId: 'repo-1',
      projectOrigin: undefined,
      number: 12,
      issueRepo: ORIGIN,
      updates
    })

    expect(window.api.gh.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: 'C:\\workspace\\widgets',
        ownerRepo: ORIGIN,
        updates
      })
    )
    expect(window.api.gh.updateIssueBySlug).not.toHaveBeenCalled()
  })
})
