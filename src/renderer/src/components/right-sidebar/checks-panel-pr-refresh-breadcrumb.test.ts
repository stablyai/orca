import { describe, expect, it, vi } from 'vitest'
import type { PRRefreshState } from '@/store/slices/github'
import {
  buildChecksPanelPRRefreshBreadcrumbData,
  recordChecksPanelPRRefreshBreadcrumb
} from './checks-panel-pr-refresh-breadcrumb'

const { recordRendererCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordRendererCrashBreadcrumbMock: vi.fn()
}))

vi.mock('@/lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: recordRendererCrashBreadcrumbMock
}))

describe('checks panel PR refresh breadcrumbs', () => {
  it('records refresh state timing without raw branch or cache key values', () => {
    const refreshState: PRRefreshState = {
      status: 'in-flight',
      reason: 'manual',
      updatedAt: 130_000
    }

    const data = buildChecksPanelPRRefreshBreadcrumbData({
      event: 'stale_cleared',
      provider: 'github',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      branch: 'feature/customer-ticket',
      prCacheKey: '/private/repo::feature/customer-ticket',
      prNumber: 42,
      prState: 'OPEN',
      prChecksStatus: 'pending',
      refreshState,
      now: 250_000
    })

    expect(data).toMatchObject({
      provider: 'github',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      branchLength: 23,
      prNumber: 42,
      prState: 'OPEN',
      prChecksStatus: 'pending',
      refreshStatus: 'in-flight',
      refreshReason: 'manual',
      refreshAgeMs: 120_000,
      refreshExpiresInMs: 0
    })
    expect(data.branchHash).toMatch(/^[0-9a-f]{8}$/)
    expect(data.prCacheKeyHash).toMatch(/^[0-9a-f]{8}$/)
    expect(Object.values(data)).not.toContain('feature/customer-ticket')
    expect(Object.values(data)).not.toContain('/private/repo::feature/customer-ticket')
  })

  it('emits the expected crash breadcrumb name', () => {
    recordChecksPanelPRRefreshBreadcrumb({
      event: 'done',
      provider: 'gitlab',
      outcome: 'review',
      durationMs: 25,
      currentRequest: true,
      now: 1_000
    })

    expect(recordRendererCrashBreadcrumbMock).toHaveBeenCalledWith('checks_panel_pr_refresh_done', {
      provider: 'gitlab',
      outcome: 'review',
      durationMs: 25,
      currentRequest: true
    })
  })
})
