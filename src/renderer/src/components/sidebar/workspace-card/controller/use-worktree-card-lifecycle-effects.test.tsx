/** @vitest-environment happy-dom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, issue } from '@/store/slices/linear/linear-slice-test-harness'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import { useWorktreeCardLifecycleEffects } from './use-worktree-card-lifecycle-effects'

const requests = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('@/runtime/linear/runtime-linear-issue-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: requests.detail
}))
vi.mock('@/hooks/useIssueMetadata', () => ({ clearLinearMetadataCache: vi.fn() }))

type Store = ReturnType<typeof createTestStore>
type CardProps = Parameters<typeof useWorktreeCardLifecycleEffects>[0]
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'project',
  hostId: 'local'
}

function LinkedIssueCard({
  store,
  id,
  sourceContext = source
}: {
  store: Store
  id: string
  sourceContext?: TaskSourceContext
}) {
  const props: CardProps = {
    worktree: {
      id,
      repoId: 'repo',
      path: `/repo/${id}`,
      displayName: id,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: id,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      head: 'head',
      branch: 'branch',
      isBare: false,
      isMainWorktree: false
    },
    repo: undefined,
    isFolder: false,
    hostedReviewCacheKey: '',
    cachedBranchFallbackGitHubPRNumber: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    branch: 'branch',
    fetchHostedReviewForBranch: vi.fn(),
    shouldRefreshHostedReview: false,
    newCardStyle: false,
    hoverDetailsOpen: false,
    showIssue: false,
    issueCacheKey: '',
    fetchIssue: vi.fn(),
    showLinearIssue: true,
    linearSourceContext: sourceContext,
    linearWorkspaceId: 'workspace',
    fetchLinearIssue: store.getState().fetchLinearIssue
  }
  useWorktreeCardLifecycleEffects(props)
  return null
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  requests.detail.mockImplementation(async (_scope, id: string) => issue(id))
})

afterEach(() => {
  cleanup()
  clearLinearRequestMaps()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('linked issue card demand', () => {
  it('bounds 100 mounted cards across 10 focus cycles over five minutes', async () => {
    const store = createTestStore()
    render(
      <>
        {Array.from({ length: 100 }, (_, index) => (
          <LinkedIssueCard key={index} id={`ISSUE-${index}`} store={store} />
        ))}
      </>
    )
    await settle()
    expect(requests.detail).toHaveBeenCalledTimes(100)

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      act(() => {
        window.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await settle()
    }
    expect(requests.detail).toHaveBeenCalledTimes(100)
  })
})
