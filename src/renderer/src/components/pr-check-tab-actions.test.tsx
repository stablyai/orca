// @vitest-environment happy-dom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  patchCachedPRChecks,
  subscribeWorkItemDetailsCache,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './github-item-dialog/load-item-details/work-item-details-cache'
import { ChecksTab as PageChecks } from './pull-request-page/checks/tab'
import { ChecksTab as DialogChecks } from './github-item-dialog/inspect-pull-request/checks-tab'

const { lookup, rows, rerun } = vi.hoisted(() => ({
  lookup: vi.fn(),
  rows: vi.fn(),
  rerun: vi.fn()
}))
vi.mock('@/store', async () => {
  const { getDefaultSettings } = await import('../../../shared/constants')
  const state = {
    settings: getDefaultSettings('/tmp/pr-check-tab-actions'),
    repos: [],
    projects: [],
    runtimeStatusByEnvironmentId: new Map()
  }
  return {
    useAppStore: Object.assign((select: (state: unknown) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
function actions({
  onRefresh,
  onRerun
}: {
  onRefresh: () => void
  onRerun: (failedOnly: boolean) => void
}) {
  const refreshAction = <button onClick={onRefresh}>Refresh</button>
  const rerunAction = <button onClick={() => onRerun(true)}>Rerun</button>
  return {
    refreshAction,
    rerunAction,
    actions: (
      <>
        {refreshAction}
        {rerunAction}
      </>
    ),
    secondaryActions: null,
    fixBrokenChecksAction: null
  }
}
vi.mock('./pull-request-page/checks/toolbar', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  buildChecksToolbar: actions
}))
vi.mock('./github-item-dialog/inspect-pull-request/checks-tab-header', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ChecksTabActions: actions
}))
const initial: GitHubWorkItem = {
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
  headSha: 'a'.repeat(40),
  prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
}
const failed: PRCheckDetail[] = [
  { name: 'Build', status: 'completed', conclusion: 'failure', url: null }
]
const summary = {
  state: 'failure' as const,
  total: 1,
  passed: 0,
  failed: 1,
  cancelled: 0,
  pending: 0,
  neutral: 0
}
const cacheKey = 'pr-checks-partial-actions-test'
function Harness({ Tab, parent = initial }: { Tab: typeof PageChecks; parent?: GitHubWorkItem }) {
  const checks = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    () => workItemDetailsCache.get(cacheKey)?.details?.checks ?? failed
  )
  return (
    <TooltipProvider>
      <Tab
        item={parent}
        repoPath="/repo"
        repoId="repo-1"
        headSha={parent.headSha}
        checks={checks}
        loading={false}
        onChecksUpdated={(next) => patchCachedPRChecks(cacheKey, next)}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  touchWorkItemDetailsCache(cacheKey, {
    details: { item: initial, body: '', comments: [], checks: failed },
    fetchedAt: 0
  })
  lookup.mockResolvedValue({ ...initial, headSha: 'b'.repeat(40), checksSummary: summary })
  rows.mockResolvedValue(failed)
  rerun.mockResolvedValue({ ok: true, count: 1 })
  Object.assign(window, {
    api: { gh: { prChecks: rows, workItemByOwnerRepo: lookup, rerunPRChecks: rerun } }
  })
  setLocalRuntimeCapabilitiesForTests([capability])
})
afterEach(() => {
  cleanup()
  workItemDetailsCache.delete(cacheKey)
  setLocalRuntimeCapabilitiesForTests(null)
})

it.each([PageChecks, DialogChecks])(
  'reruns the refreshed head while the parent still has the prior head',
  async (Tab) => {
    render(<Harness Tab={Tab} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    expect(rows.mock.calls[0][0]).toMatchObject({ headSha: 'b'.repeat(40) })
    lookup.mockRejectedValueOnce(new Error('owner unavailable'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rerun' }))
    })
    expect(rerun.mock.calls[0][0]).toMatchObject({
      prNumber: 42,
      headSha: 'b'.repeat(40),
      failedOnly: true
    })
    expect(rows.mock.calls[1][0]).toMatchObject({ headSha: 'b'.repeat(40) })
    expect(screen.getByText('1 check failing')).toBeTruthy()
  }
)
