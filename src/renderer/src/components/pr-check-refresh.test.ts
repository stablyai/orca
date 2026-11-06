import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refreshPullRequestChecks } from './pull-request-page/checks/refresh'
import {
  refreshGitHubChecksTab,
  type ChecksTabActionContext
} from './github-item-dialog/inspect-pull-request/checks-tab-actions'
import { createGitHubChecksTabState } from './github-checks-tab-state'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { getOverallCheckCounts } from './pr-check-counts'
const { lookup, rows } = vi.hoisted(() => ({ lookup: vi.fn(), rows: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const item: GitHubWorkItem = {
  id: 'pr-42',
  repoId: 'repo-1',
  number: 42,
  type: 'pr',
  title: 'PR',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/42',
  labels: [],
  author: null,
  updatedAt: '2026-11-04',
  headSha: 'head',
  prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
}
const summary = {
  state: 'failure' as const,
  total: 101,
  passed: 100,
  failed: 1,
  cancelled: 0,
  pending: 0,
  neutral: 0
}
function context() {
  return {
    canUseChecksRepoContext: true,
    runtimeHost: null,
    repoId: item.repoId,
    repoPath: '/repo',
    item,
    itemNumber: 42,
    itemRepoId: item.repoId,
    headSha: 'head',
    prRepo: item.prRepo!,
    mountedRef: { current: true },
    committedChecksContextOwnerRef: {
      current: createGitHubChecksTabState([], 'repo').contextOwner
    },
    nextChecksRefreshRequestIdRef: { current: 0 },
    activeChecksRefreshRequestIdRef: { current: null },
    nextCheckDetailsRequestIdRef: { current: 0 },
    setRefreshingOwner: vi.fn(),
    setChecksState: vi.fn(),
    setRerunningOwner: vi.fn(),
    onChecksUpdated: vi.fn(),
    onOwnerUpdated: vi.fn()
  } satisfies ChecksTabActionContext
}
beforeEach(() => {
  lookup.mockReset()
  rows.mockReset()
  Object.assign(globalThis, {
    window: { api: { gh: { prChecks: rows, workItemByOwnerRepo: lookup } } }
  })
  rows.mockResolvedValue([{ name: 'Build', status: 'completed', conclusion: 'success', url: null }])
  setLocalRuntimeCapabilitiesForTests([capability])
})
afterEach(() => setLocalRuntimeCapabilitiesForTests(null))

it.each(['page', 'dialog'])(
  'refreshes the %s owner and uses its counts while returned rows remain partial',
  async (surface) => {
    const ctx = context()
    const refresh = () =>
      surface === 'page' ? refreshPullRequestChecks(ctx) : refreshGitHubChecksTab(ctx)
    lookup.mockResolvedValue({ ...item, checksSummary: summary })
    const checks = await refresh()
    const owner = ctx.onOwnerUpdated.mock.calls[0][0]
    expect(getOverallCheckCounts(checks!, owner)).toMatchObject({ passing: 100, failing: 1 })
    lookup.mockResolvedValue({
      ...item,
      checksSummary: { ...summary, state: 'success', total: 101, passed: 101, failed: 0 }
    })
    await refresh()
    expect(ctx.onOwnerUpdated.mock.calls[1][0].checksSummary).toMatchObject({
      state: 'success',
      passed: 101
    })
    const deferred = Promise.withResolvers<GitHubWorkItem>()
    lookup.mockReturnValue(deferred.promise)
    const pending = refresh()
    ctx.committedChecksContextOwnerRef.current = {}
    deferred.resolve({ ...item, checksSummary: summary })
    await pending
    expect(ctx.onOwnerUpdated).toHaveBeenCalledTimes(2)
  }
)

it('keeps the supported old-host refresh parameters and row-only publication', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const ctx = context()
  await refreshPullRequestChecks(ctx)
  expect(lookup).not.toHaveBeenCalled()
  expect(ctx.onOwnerUpdated).not.toHaveBeenCalled()
  expect(ctx.onChecksUpdated.mock.calls[0][0]).toHaveLength(1)
  expect(rows.mock.calls[0][0]).toMatchObject({ prNumber: 42, headSha: 'head', noCache: true })
})

it.each(['page', 'dialog'])('settles %s owner and row failures independently', async (surface) => {
  const ctx = context()
  const refresh = () =>
    surface === 'page' ? refreshPullRequestChecks(ctx) : refreshGitHubChecksTab(ctx)
  lookup.mockResolvedValue({ ...item, checksSummary: summary })
  rows.mockRejectedValueOnce(new Error('rows failed'))
  await refresh()
  expect(ctx.onOwnerUpdated.mock.calls[0][0].checksSummary).toEqual(summary)
  expect(ctx.onChecksUpdated).not.toHaveBeenCalled()
  lookup.mockRejectedValueOnce(new Error('owner failed'))
  await refresh()
  expect(ctx.onChecksUpdated.mock.calls[0][0]).toHaveLength(1)
  expect(ctx.onOwnerUpdated.mock.calls[1][0].checksSummary).toBeUndefined()
})
