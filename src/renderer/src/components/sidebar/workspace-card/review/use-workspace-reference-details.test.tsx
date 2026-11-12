import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as VisibleReviewTargets from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets'
import { useWorkspaceReferenceDetails } from './use-workspace-reference-details'

import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { getWorkspaceReferenceRequest } from './workspace-reference-details'
import '../../../../../../shared/work-items/task-source-context'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review/hosted-review-request-state'

import {
  referenceAttachment,
  referenceRepo,
  referenceReview,
  referenceWorkspace
} from './workspace-reference-fixtures.test-support'

vi.mock('@/store/index', async () => {
  const browserWindow = globalThis.window
  const { createTestStore } = await import('@/store/github/github-slice-test-harness')
  globalThis.window = browserWindow
  return { useAppStore: createTestStore() }
})
// Branch refresh has its own integration suite; this suite exercises the additional exact targets.
vi.mock(
  '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets',
  async (original) => ({
    ...(await original<typeof VisibleReviewTargets>()),
    getVisibleHostedReviewRefreshTargets: () => [],
    visibleHostedReviewRefreshInputsChanged: () => true
  })
)
const mocks = vi.hoisted(() => ({ web: false }))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: () => mocks.web
}))
const read = vi.fn<(...args: unknown[]) => Promise<ReturnType<typeof referenceReview> | null>>()
const workspace = {
  ...referenceWorkspace,
  linkedPR: null,
  linkedItems: [referenceAttachment(1), referenceAttachment(2)]
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
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    agentStatusEpoch: 0,
    sshConnectionStates: new Map()
  })
})
afterEach(cleanup)

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
