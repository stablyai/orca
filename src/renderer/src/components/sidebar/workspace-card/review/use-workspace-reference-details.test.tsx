// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as VisibleReviewTargets from '@/store/github/visible-hosted-review-refresh-targets'
import { useWorkspaceReferenceDetails } from './use-workspace-reference-details'
import { useVisibleHostedReviewRefresh } from '@/app-shell/use-visible-hosted-review-refresh'
import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { getWorkspaceReferenceRequest } from './workspace-reference-details'
import {
  normalizeTaskSourceContext,
  getTaskSourceCacheScope
} from '../../../../../../shared/task-source-context'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review-request-state'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import {
  referenceAttachment,
  referenceRepo,
  referenceReview,
  referenceWorkspace,
  referenceLinearIssue
} from './workspace-reference-fixtures.test-support'

vi.mock('@/store', async () => {
  const browserWindow = globalThis.window
  const { createTestStore } = await import('@/store/slices/github-slice-test-harness')
  globalThis.window = browserWindow
  return { useAppStore: createTestStore() }
})
// Branch refresh has its own integration suite; this suite exercises the additional exact targets.
vi.mock('@/store/github/visible-hosted-review-refresh-targets', async (original) => ({
  ...(await original<typeof VisibleReviewTargets>()),
  getVisibleHostedReviewRefreshTargets: () => [],
  visibleHostedReviewRefreshInputsChanged: () => true
}))
const mocks = vi.hoisted(() => ({ web: false }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
const read = vi.fn<(...args: unknown[]) => Promise<ReturnType<typeof referenceReview> | null>>()
const workspace = {
  ...referenceWorkspace,
  linkedPR: null,
  linkedItems: [referenceAttachment(1), referenceAttachment(2)]
}
function mount(open = false, enabled = true) {
  return renderHook(() => {
    useVisibleHostedReviewRefresh({ enabled })
    return useWorkspaceReferenceDetails(workspace, referenceRepo, null, open)
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  _clearHostedReviewRequestGenerationsForTest()
  mocks.web = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hostedReview: { forBranch: read } }
  })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  read.mockResolvedValue(null)
  useAppStore.setState({
    settings: null,
    repos: [referenceRepo],
    worktreesByRepo: { repo: [workspace] },
    visibleReviewWorktreeIds: [workspace.id],
    activeWorktreeId: null,
    hostedReviewCache: {},
    prCache: {},
    linearIssueCache: {},
    jiraIssueSummaryCache: {},
    issueCache: {},
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {
      [workspace.id]: [
        {
          id: 'browser',
          worktreeId: workspace.id,
          url: '',
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    sshConnectionStates: new Map()
  })
})
afterEach(cleanup)
it('shares exact results across hover and scheduler without replacing the primary branch cache', async () => {
  const primaryKey = getHostedReviewCacheKey(
    referenceRepo.path,
    workspace.branch,
    null,
    referenceRepo.id,
    null,
    null,
    true
  )
  const primary = { data: referenceReview(7), fetchedAt: Date.now() }
  useAppStore.setState({ hostedReviewCache: { [primaryKey]: primary } })
  read.mockImplementation(async (args) =>
    referenceReview(
      typeof args === 'object' &&
        args &&
        'linkedGitHubPR' in args &&
        typeof args.linkedGitHubPR === 'number'
        ? args.linkedGitHubPR
        : 0
    )
  )
  const hook = mount(true)
  await waitFor(() => expect(Object.values(hook.result.current).filter(Boolean)).toHaveLength(2))
  expect(read).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().hostedReviewCache[primaryKey]).toBe(primary)
})
it('keeps failed exact refreshes stale while retaining their last known details', async () => {
  const request = getWorkspaceReferenceRequest(referenceAttachment(1), workspace, referenceRepo)
  useAppStore.setState({
    hostedReviewCache: {
      [request.key]: { data: referenceReview(1), fetchedAt: Date.now() - 61_000 }
    }
  })
  read.mockRejectedValue(new Error('Disconnected'))
  await readWorkspaceReferenceDetails(request)
  const hook = renderHook(() => useWorkspaceReferenceDetails(workspace, referenceRepo, null, false))
  expect(hook.result.current[getWorkspaceAttachmentKey(request.item)]).toMatchObject({
    stale: true,
    review: { number: 1 }
  })
})
it('does not revive primary success after an exact lookup returns unavailable', async () => {
  const request = getWorkspaceReferenceRequest(referenceAttachment(1), workspace, referenceRepo)
  await readWorkspaceReferenceDetails(request)
  const hook = renderHook(() =>
    useWorkspaceReferenceDetails(workspace, referenceRepo, referenceReview(1), false)
  )
  expect(hook.result.current[getWorkspaceAttachmentKey(request.item)]).toBeUndefined()
})

it('projects task mutations directly from the source provider cache', () => {
  const source = normalizeTaskSourceContext({
    provider: 'linear',
    projectId: 'project',
    hostId: 'local'
  })
  if (!source) {
    throw new Error('Invalid fixture')
  }
  const item = {
    provider: 'linear',
    type: 'issue',
    number: 0,
    identifier: 'ENG-1',
    taskSourceContext: source
  } as const
  const key = `${getTaskSourceCacheScope(source)}::all::ENG-1`
  useAppStore.setState({
    linearIssueCache: { [key]: { data: referenceLinearIssue(), fetchedAt: Date.now() } }
  })
  const hook = renderHook(() =>
    useWorkspaceReferenceDetails({ ...workspace, linkedItems: [item] }, referenceRepo, null, false)
  )
  expect(hook.result.current[getWorkspaceAttachmentKey(item)]?.title).toBe('Task')
  act(() =>
    useAppStore.setState({
      linearIssueCache: {
        [key]: { data: referenceLinearIssue({ title: 'Edited' }), fetchedAt: Date.now() }
      }
    })
  )
  expect(hook.result.current[getWorkspaceAttachmentKey(item)]?.title).toBe('Edited')
  const otherAccount = { ...item, taskSourceContext: { ...source, accountLabel: 'other' } }
  const other = renderHook(() =>
    useWorkspaceReferenceDetails(
      { ...workspace, linkedItems: [otherAccount] },
      referenceRepo,
      null,
      false
    )
  )
  expect(other.result.current[getWorkspaceAttachmentKey(otherAccount)]).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})
