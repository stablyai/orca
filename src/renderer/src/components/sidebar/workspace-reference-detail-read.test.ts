// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { getWorkspaceReferenceRequest } from './workspace-reference-details'
import {
  referenceAttachment,
  referenceRepo,
  referenceWorkspace,
  referenceReview,
  referenceLinearIssue
} from './workspace-reference-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  review: vi.fn<(...args: unknown[]) => Promise<HostedReviewInfo | null>>(),
  linear: vi.fn<(...args: unknown[]) => Promise<LinearIssue | null>>(),
  jira: vi.fn(),
  issue: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      hostedReviewCache: {},
      linearIssueCache: {},
      jiraIssueSummaryCache: {},
      issueCache: {},
      fetchHostedReviewForBranch: mocks.review,
      settings: { activeRuntimeEnvironmentId: 'focused-elsewhere' },
      fetchLinearIssue: mocks.linear,
      lookupJiraIssueSummary: mocks.jira,
      fetchIssue: mocks.issue
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hostedReview: { forBranch: mocks.review } }
  })
})
describe('source-scoped workspace reference status reads', () => {
  it.each(['open', 'merged', 'draft'] as const)(
    'loads the exact %s sibling without workspace HEAD filtering or branch cache mutation',
    async (state) => {
      mocks.review.mockResolvedValue(referenceReview(42, { state, baseRefName: 'release' }))
      const item = referenceAttachment(42)
      const detail = await readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(item, referenceWorkspace, referenceRepo)
      )
      expect(detail?.review?.state).toBe(state)
      expect(mocks.review).toHaveBeenCalledWith(
        '/repo',
        'feature',
        expect.objectContaining({
          linkedGitHubPR: 42,
          linkedGitLabMR: null,
          repoOwnerExecutionHostId: 'local'
        })
      )
      expect(mocks.review.mock.calls[0]?.[2]).not.toHaveProperty('currentHeadOid')
    }
  )
  it.each(['runtime:owner', 'ssh:owner'] as const)(
    'uses the %s repository owner',
    async (executionHostId) => {
      mocks.review.mockResolvedValue(referenceReview())
      await readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(referenceAttachment(), referenceWorkspace, {
          ...referenceRepo,
          executionHostId
        })
      )
      expect(mocks.review).toHaveBeenCalledWith(
        '/repo',
        'feature',
        expect.objectContaining({ repoOwnerExecutionHostId: executionHostId })
      )
    }
  )
  it('rejects branch fallback, wrong provider and wrong repository responses', async () => {
    const request = getWorkspaceReferenceRequest(
      referenceAttachment(),
      referenceWorkspace,
      referenceRepo
    )
    for (const review of [
      referenceReview(9),
      referenceReview(7, { provider: 'gitlab' }),
      referenceReview(7, { url: 'https://github.com/other/orca/pull/7' })
    ]) {
      mocks.review.mockResolvedValue(review)
      expect(await readWorkspaceReferenceDetails(request)).toBeNull()
    }
  })
  it('does not route folder or known foreign reviews through the current git repository', async () => {
    expect(
      await readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(referenceAttachment(), {
          ...referenceWorkspace,
          id: 'folder:docs'
        })
      )
    ).toBeNull()
    expect(
      await readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(
          { ...referenceAttachment(), url: 'https://github.com/other/orca/pull/7' },
          referenceWorkspace,
          referenceRepo
        )
      )
    ).toBeNull()
    expect(mocks.review).not.toHaveBeenCalled()
  })
  it('binds Linear workspace and host, then rejects same identifier from another organization', async () => {
    const context = normalizeTaskSourceContext({
      provider: 'linear',
      projectId: 'project',
      hostId: 'runtime:linear-owner',
      providerIdentity: { provider: 'linear', workspaceId: 'workspace' }
    })
    const item = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      identifier: 'ENG-1',
      url: 'https://linear.app/acme/issue/ENG-1/task',
      taskSourceContext: context ?? undefined
    }
    mocks.linear.mockResolvedValue(referenceLinearIssue())
    const request = getWorkspaceReferenceRequest(item, referenceWorkspace, referenceRepo)
    expect((await readWorkspaceReferenceDetails(request))?.stateName).toBe('In Progress')
    expect(mocks.linear).toHaveBeenCalledWith('ENG-1', 'workspace', { sourceContext: context })
    mocks.linear.mockResolvedValue(
      referenceLinearIssue({ url: 'https://linear.app/other/issue/ENG-1/task' })
    )
    expect(await readWorkspaceReferenceDetails(request)).toBeNull()
  })
  it('keys equal numbers separately by owning host and task account', () => {
    const local = getWorkspaceReferenceRequest(
      referenceAttachment(),
      referenceWorkspace,
      referenceRepo
    )
    const remote = getWorkspaceReferenceRequest(referenceAttachment(), referenceWorkspace, {
      ...referenceRepo,
      connectionId: 'owner'
    })
    expect(local.key).not.toBe(remote.key)
    const context = normalizeTaskSourceContext({
      provider: 'github',
      projectId: 'project',
      hostId: 'local',
      accountLabel: 'account-a'
    })
    const first = getWorkspaceReferenceRequest(
      { ...referenceAttachment(), taskSourceContext: context ?? undefined },
      referenceWorkspace,
      referenceRepo
    )
    const second = getWorkspaceReferenceRequest(
      {
        ...referenceAttachment(),
        taskSourceContext: context ? { ...context, accountLabel: 'account-b' } : undefined
      },
      referenceWorkspace,
      referenceRepo
    )
    expect(first.key).not.toBe(second.key)
    expect(
      getWorkspaceReferenceRequest(referenceAttachment(), referenceWorkspace, {
        ...referenceRepo,
        ghAccount: { host: 'github.com', user: 'other' }
      }).key
    ).not.toBe(local.key)
  })
  it('uses the same all-workspaces cache slot as the existing card when no Linear workspace is bound', async () => {
    const source = normalizeTaskSourceContext({
      provider: 'linear',
      projectId: 'project',
      hostId: 'local'
    })
    const item = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      identifier: 'ENG-1',
      taskSourceContext: source ?? undefined
    }
    mocks.linear.mockResolvedValue(referenceLinearIssue())
    expect(
      (
        await readWorkspaceReferenceDetails(
          getWorkspaceReferenceRequest(item, referenceWorkspace, referenceRepo)
        )
      )?.stateType
    ).toBe('started')
    expect(mocks.linear).toHaveBeenCalledWith('ENG-1', 'all', { sourceContext: source })
  })
  it('fails closed for incompatible per-reference account, repository binding and bare provider', async () => {
    for (const fields of [
      { accountLabel: 'other-account' },
      { repoId: 'foreign-repo' },
      { providerIdentity: { provider: 'github' as const, owner: 'other', repo: 'orca' } }
    ]) {
      const context = normalizeTaskSourceContext({
        provider: 'github',
        projectId: 'project',
        hostId: 'local',
        ...fields
      })
      const request = getWorkspaceReferenceRequest(
        { ...referenceAttachment(), taskSourceContext: context ?? undefined },
        referenceWorkspace,
        referenceRepo
      )
      expect(await readWorkspaceReferenceDetails(request)).toBeNull()
    }
    const wrongProvider = getWorkspaceReferenceRequest(
      { provider: 'gitlab', type: 'mr', number: 7 },
      referenceWorkspace,
      referenceRepo
    )
    expect(await readWorkspaceReferenceDetails(wrongProvider)).toBeNull()
    expect(mocks.review).not.toHaveBeenCalled()
  })
  it('retains native admission after hover cancellation until the timed-out read settles', async () => {
    const rejecters: ((error: Error) => void)[] = []
    mocks.linear.mockImplementation(() => new Promise((_resolve, reject) => rejecters.push(reject)))
    mocks.review.mockResolvedValue(referenceReview(99))
    const controller = new AbortController()
    const tasks = Array.from({ length: 3 }, (_, index) =>
      readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(
          { provider: 'linear', type: 'issue', number: 0, identifier: `ENG-${index + 1}` },
          referenceWorkspace,
          referenceRepo
        ),
        controller.signal
      ).catch(() => null)
    )
    try {
      await vi.waitFor(() => expect(mocks.linear).toHaveBeenCalledTimes(3))
      controller.abort()
      const review = readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(referenceAttachment(99), referenceWorkspace, referenceRepo)
      )
      await Promise.resolve()
      expect(mocks.review).not.toHaveBeenCalled()
      rejecters[0](new Error('Linear issue detail lookup timed out'))
      await expect(review).resolves.toMatchObject({ title: 'Review 99' })
    } finally {
      for (const reject of rejecters) {
        reject(new Error('Read settled'))
      }
      await Promise.all(tasks)
    }
  })
})
