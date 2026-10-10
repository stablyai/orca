import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { findVisibleBrowserLinkTarget } from '@/lib/visible-browser-link-target'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: vi.fn(),
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({})
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const WT = 'repo1::/path/wt1'

describe('a routed link into a lone browser pane', () => {
  it('joins that pane instead of opening beside it', () => {
    const store = createTestStore()
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
      activeWorktreeId: WT
    })
    const original = store
      .getState()
      .createBrowserTab(WT, 'https://example.com/old', { browserRuntimeEnvironmentId: null })
    const before = store.getState()
    const groupId = before.groupsByWorktree[WT]![0]!.id
    const placement = findVisibleBrowserLinkTarget(before, WT)
    expect(placement?.targetGroupId).toBe(groupId)

    store.getState().createBrowserTab(WT, 'https://example.com/new', {
      activate: true,
      browserRuntimeEnvironmentId: null,
      ...placement
    })

    const after = store.getState()
    expect(after.layoutByWorktree[WT]).toBe(before.layoutByWorktree[WT])
    expect(after.groupsByWorktree[WT]).toHaveLength(1)
    const rows = after.unifiedTabsByWorktree[WT]!
    expect(rows.map((t) => t.groupId)).toEqual([groupId, groupId])
    expect(after.groupsByWorktree[WT]![0]!.activeTabId).toBe(rows[1]!.id)
    expect(after.browserTabsByWorktree[WT]!.map((t) => t.id)).toContain(original.id)
  })
})
