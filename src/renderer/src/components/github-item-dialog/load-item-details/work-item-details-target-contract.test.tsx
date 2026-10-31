import type * as GitRunner from '../../../../../main/git/runner'
import type { GitHubRepoContext } from '../../../../../main/github/github-repository-identity'
import type { PRComment } from '../../../../../shared/github/comment-types'
// @vitest-environment happy-dom
import PullRequestPage from '@/components/pull-request-page/page/surface'
import GitHubItemDialog from '../open-dialog/github-item-dialog'
import type {
  GitHubWorkItemDetails,
  GitHubWorkItem
} from '../../../../../shared/github/work-item-types'
import {
  patchCachedWorkItemBody,
  getWorkItemDetailsCacheKey,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'
import { listLabels } from '../../../../../main/github/issue-field-options'
import { useRepoLabels } from '@/hooks/useGitHubRepoMetadata'
import { GitHubWorkItemTargetContext } from './github-work-item-target-context'
import { updateIssue } from '../../../../../main/github/issue-update'
import { updatePullRequestBySlug } from '../../../../../main/github/project-view/pull-request-mutation'
import { updateIssueBySlug } from '../../../../../main/github/project-view/mutations'
import { listLabelsBySlug } from '../../../../../main/github/project-view/repository-field-options'
import { getWorkItemWithRepository } from '../../../../../main/github/client/fetch/get-work-item'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { WorkItemDetails } from '../../../../../shared/rpc-contract/github-repo-work-item-params'
import { getWorkItemDetails } from '../../../../../main/github/work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from '../../../../../main/github/github-api-repository'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'

type Published = {
  onCommentAdded: (comment: PRComment) => void
  body: string
  details: GitHubWorkItemDetails | null
  detailsCacheKey: string | null
  appendOptimisticComment: (comment: PRComment) => void
}
const published = vi.hoisted(() => new Map<string, Published>())
vi.mock('@/store/selectors', () => ({ useAllWorktrees: () => [] }))
vi.mock('@/lib/github-work-item-workspace-attachment', () => ({
  findGithubPrWorkspaceAttachment: () => null,
  findGithubIssueWorkspaceAttachment: () => null
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/components/pull-request-page/page/header', () => ({ PullRequestPageHeader: () => null }))
vi.mock('../open-dialog/github-item-dialog-pr-header', () => ({
  GitHubItemDialogPRHeader: () => null
}))
vi.mock('../open-dialog/github-item-dialog-issue-header', () => ({
  GitHubItemDialogIssueHeader: () => null
}))
vi.mock('../open-dialog/github-item-dialog-issue-body', () => ({
  GitHubItemDialogIssueBody: () => null
}))
vi.mock('../edit-item-fields/gh-edit-section', () => ({ GHEditSection: () => null }))
vi.mock('@/components/pull-request-page/edit/section', () => ({ GHEditSection: () => null }))
vi.mock('@/components/pull-request-page/page/tabs-shell', () => ({
  PullRequestPageTabs: (props: Published) => {
    published.set('page', props)
    return <div>{props.body}</div>
  }
}))
vi.mock('../open-dialog/github-item-dialog-pr-tabs', () => ({
  GitHubItemDialogPRTabs: (props: Published) => {
    published.set('dialog', {
      ...props,
      body: props.details?.body ?? '',
      appendOptimisticComment: props.onCommentAdded
    })
    return <div>{props.body}</div>
  }
}))

const io = vi.hoisted(() => ({
  gh: vi.fn(),
  host: 'github.com',
  capable: true,
  rpc: vi.fn(),
  setViewed: vi.fn(),
  preference: 'upstream' as 'upstream' | 'origin',
  upstreamIsIssue: false,
  recordInteraction: vi.fn(),
  unexpected: new Array<string>()
}))
vi.mock('../../../../../main/git/runner', async (original) => ({
  ...(await original<typeof GitRunner>()),
  ghExecFileAsync: io.gh
}))
vi.mock('../../../../../main/github/gh-utils', () => ({
  ghExecFileAsync: io.gh,
  classifyGhError: () => ({ type: 'not_found', message: 'Not found' }),
  acquire: vi.fn(),
  release: vi.fn(),
  ghRepoExecOptions: (context: GitHubRepoContext) => context,
  githubRepoContext: (repoPath: string) => ({ cwd: repoPath }),
  getOwnerRepoForRemote: async (_path: string, remote: string) =>
    io.host === 'github.com'
      ? { owner: remote === 'origin' ? 'fork' : 'upstream', repo: 'widgets' }
      : null
}))
vi.mock('../../../../../main/github/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: async () => ({ owner: 'fork', repo: 'widgets', host: io.host }),
  getEnterpriseGitHubRepoSlugForRemote: async () => ({
    owner: 'upstream',
    repo: 'widgets',
    host: io.host
  }),
  isGitHubHostAuthenticated: async () => true,
  isGitHubHostAuthenticatedForGlobalCli: async () => true
}))
vi.mock('../../../../../main/git/remote-name-listing', () => ({
  shouldProbeGitRemote: async () => true
}))
vi.mock('../../../../../main/github/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => false
}))
vi.mock('../../../../../main/github/client', async () => ({
  ...(await import('../../../../../main/github/client/fetch/get-work-item')),
  ...(await import('../../../../../main/github/client/check/get-pr-checks')),
  ...(await import('../../../../../main/github/client/fetch/get-pr-comments'))
}))
vi.mock('@/store', () => {
  const state = {
    repos: [{ id: 'clone', path: '/clone', issueSourcePreference: 'upstream' }],
    recordFeatureInteraction: io.recordInteraction
  }
  return {
    useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: io.rpc,
  runtimeEnvironmentSupportsCapability: async () => io.capable
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => ['github.exact-work-item-target.v1']
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function response(value: unknown) {
  return { stdout: JSON.stringify(value) }
}
function item(owner: string): GitHubWorkItem {
  return {
    id: 'pr:93',
    repoId: 'clone',
    type: 'pr',
    number: 93,
    title: owner,
    url: `https://${io.host}/${owner}/widgets/pull/93`,
    prRepo: { owner, repo: 'widgets', host: io.host },
    state: 'open',
    labels: [],
    author: null,
    updatedAt: ''
  }
}
let labels: ReturnType<typeof useRepoLabels>
function Metadata({ enabled }: { enabled: boolean }) {
  labels = useRepoLabels(enabled ? '/clone' : null, enabled ? 'clone' : null)
  return null
}
let view: ReturnType<typeof useGitHubWorkItemDetails>
let root: ReturnType<typeof createRoot>
const NOW = Date.UTC(2026, 9, 31, 12)
function Probe({
  opened,
  sourceContext,
  metadataEnabled = true
}: {
  opened: GitHubWorkItem
  sourceContext?: TaskSourceContext
  metadataEnabled?: boolean
}) {
  view = useGitHubWorkItemDetails({
    workItem: opened,
    repoPath: '/clone',
    effectiveRepoId: 'clone',
    sourceContext
  })
  return (
    <GitHubWorkItemTargetContext.Provider value={view.targetContext}>
      <Metadata enabled={metadataEnabled} />
    </GitHubWorkItemTargetContext.Provider>
  )
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  _resetOriginGitHubApiRepositoryCache()
  workItemDetailsCache.clear()
  io.capable = true
  io.preference = 'upstream'
  io.upstreamIsIssue = false
  io.unexpected.length = 0
  io.rpc.mockReset()
  io.gh.mockReset().mockImplementation(async (args: string[]) => {
    const owner =
      args.includes('fork/widgets') ||
      args.includes('owner=fork') ||
      args.some((a) => a.startsWith('repos/fork/'))
        ? 'fork'
        : 'upstream'
    const query = args.find((a) => a.startsWith('query=')) ?? ''
    if (args.some((a) => a.endsWith('/labels'))) {
      return { stdout: `${owner}-label` }
    }
    const issueReply = {
      number: 93,
      title: `${owner} issue`,
      state: 'open',
      html_url: `https://${io.host}/${owner}/widgets/issues/93`,
      updated_at: '2026-10-28T00:00:00Z',
      user: null,
      labels: [],
      assignees: [],
      body: `${owner} issue body`
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return response({
        number: 93,
        title: issueReply.title,
        state: 'OPEN',
        url: issueReply.html_url,
        updatedAt: issueReply.updated_at,
        author: null,
        labels: []
      })
    }
    if (args[0] === 'issue' && ['close', 'reopen', 'edit'].includes(args[1])) {
      return { stdout: '' }
    }
    if (args[0] === 'api' && args.includes('PATCH')) {
      if (args.some((arg) => /^repos\/(fork|upstream)\/widgets\/(issues|pulls)\/93$/.test(arg))) {
        return response({ number: 93 })
      }
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (io.upstreamIsIssue && owner === 'upstream') {
        throw new Error('HTTP 404: Not Found')
      }
      return response({
        number: 93,
        title: owner,
        state: 'OPEN',
        url: item(owner).url,
        labels: [],
        updatedAt: '2026-10-28T00:00:00Z',
        author: null,
        isDraft: false,
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: `${owner}-head`,
        reviewRequests: [],
        latestReviews: []
      })
    }
    if (args.some((arg) => /^repos\/(fork|upstream)\/widgets\/issues\/93$/.test(arg))) {
      return response(issueReply)
    }
    if (query.includes('viewerViewedState')) {
      return response({
        data: {
          repository: {
            pullRequest: { participants: { nodes: [] } },
            viewedPullRequest: {
              id: `PR_${owner}`,
              files: {
                nodes: [{ path: `${owner}.ts`, viewerViewedState: 'UNVIEWED' }],
                pageInfo: { hasNextPage: false }
              }
            }
          }
        }
      })
    }
    if (query.includes('reviewThreads')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [
                  {
                    id: `COMMENT_${owner}`,
                    databaseId: 1,
                    author: null,
                    body: `${owner} conversation`,
                    createdAt: '2026-10-28',
                    url: item(owner).url
                  }
                ]
              },
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] }
            }
          }
        }
      })
    }
    if (query.includes('statusCheckRollup')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: `${owner} check`,
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS'
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      })
    }
    if (args.some((a) => a.includes('/files?'))) {
      return response([
        {
          filename: `${owner}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1 +1 @@\n-a\n+b'
        }
      ])
    }
    if (args.some((a) => a.endsWith('/pulls/93'))) {
      if (io.upstreamIsIssue && owner === 'upstream') {
        throw new Error('HTTP 404: Not Found')
      }
      return response({
        number: 93,
        title: owner,
        state: 'open',
        html_url: item(owner).url,
        updated_at: '2026-10-28T00:00:00Z',
        user: null,
        labels: [],
        assignees: [],
        draft: false,
        body: `${owner} body`,
        head: { sha: `${owner}-head`, ref: 'feature', repo: { owner: { login: owner } } },
        base: { sha: `${owner}-base`, ref: 'main', repo: { owner: { login: owner } } }
      })
    }
    if (query.includes('viewerDefaultMergeMethod')) {
      return response({
        data: {
          repository: {
            viewerDefaultMergeMethod: 'SQUASH',
            mergeCommitAllowed: true,
            rebaseMergeAllowed: true,
            squashMergeAllowed: true,
            autoMergeAllowed: false,
            mergeQueue: null,
            ref: { rules: { nodes: [] } }
          }
        }
      })
    }
    if (query.includes('participants(first: 100)')) {
      return response({
        data: {
          repository: {
            pullRequest: { participants: { nodes: [] } },
            issue: { participants: { nodes: [] } }
          }
        }
      })
    }
    io.unexpected.push(JSON.stringify(args))
    throw new Error(`Unexpected gh command: ${JSON.stringify(args)}`)
  })
  io.setViewed.mockReset().mockResolvedValue(true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        workItemDetails: async (args: Parameters<typeof window.api.gh.workItemDetails>[0]) => {
          const parsed = WorkItemDetails.parse({ repo: args.repoId, ...args })
          return getWorkItemDetails(
            args.repoPath,
            parsed.number,
            parsed.type,
            null,
            {},
            io.preference,
            parsed.ownerRepo
          )
        },
        listLabels: async (args: Parameters<typeof window.api.gh.listLabels>[0]) =>
          listLabels(args.repoPath, 'upstream', null, {}, args.ownerRepo),
        updateIssue: async (args: Parameters<typeof window.api.gh.updateIssue>[0]) =>
          updateIssue(
            args.repoPath,
            args.number,
            args.updates,
            null,
            {},
            'upstream',
            args.ownerRepo
          ),
        updatePullRequestBySlug,
        updateIssueBySlug,
        listLabelsBySlug,
        notifyWorkItemMutated: vi.fn().mockResolvedValue(true),
        setPRFileViewed: io.setViewed
      }
    }
  })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(io.unexpected).toEqual([])
})

it.each(['github.com', 'github.corp'])(
  'keeps %s fork details and viewed node IDs together through the real details path',
  async (host) => {
    io.host = host
    const opened = item('fork')
    const upstream = await getWorkItemDetails('/clone', 93, 'pr')
    expect(upstream?.body).toBe('upstream body')
    const key = getWorkItemDetailsCacheKey({
      repoPath: '/clone',
      repoId: 'clone',
      issueSourcePreference: 'upstream',
      type: 'pr',
      number: 93,
      ownerRepo: opened.prRepo
    })
    touchWorkItemDetailsCache(key, { details: upstream, fetchedAt: NOW })
    io.gh.mockClear()
    // A reused, wrongly keyed entry must be rejected before the first paint.
    let firstDetails: typeof upstream | undefined
    function FirstPaint() {
      const content = Probe({ opened })
      if (firstDetails === undefined) {
        firstDetails = view.details
      }
      return content
    }
    await act(async () => root.render(<FirstPaint />))
    expect(firstDetails).toBeNull()
    expect(view.error).toBeNull()
    expect(labels.data).toEqual(['fork-label'])
    expect(view.details).toMatchObject({
      body: 'fork body',
      headSha: 'fork-head',
      baseSha: 'fork-base',
      pullRequestId: 'PR_fork',
      files: [{ path: 'fork.ts' }],
      comments: [{ body: 'fork conversation' }],
      checks: [{ name: 'fork check' }]
    })
    expect(io.gh.mock.calls.every(([, options]) => options.host === host)).toBe(true)
    expect(view.displayWorkItem).toMatchObject({ url: opened.url, prRepo: opened.prRepo })
    expect(
      io.gh.mock.calls.some(
        ([args]) =>
          args.includes('upstream/widgets') ||
          args.includes('owner=upstream') ||
          args.some((a: string) => a.startsWith('repos/upstream/'))
      )
    ).toBe(false)
    await act(async () => {
      expect(await view.handlePRFileViewedChange('fork.ts', true)).toBe(true)
    })
    await runIssueUpdate({
      repoPath: '/clone',
      repoId: 'clone',
      projectOrigin: undefined,
      issueRepo: opened.prRepo,
      type: 'pr',
      number: 93,
      updates: { addAssignees: ['someone'] }
    })
    expect(io.gh).toHaveBeenCalledWith(
      ['issue', 'edit', '93', '--repo', 'fork/widgets', '--add-assignee', 'someone'],
      expect.objectContaining({ host })
    )
    expect(io.setViewed).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestId: 'PR_fork', prRepo: opened.prRepo, path: 'fork.ts' })
    )
  }
)

it('retains accepted legacy details and exact viewed actions when generic metadata is unsupported', async () => {
  io.host = 'github.com'
  io.capable = false
  const opened = item('fork')
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'project',
    repoId: 'remote-clone',
    hostId: 'runtime:paired'
  }
  const fork = await getWorkItemDetails('/clone', 93, 'pr', null, {}, 'upstream', opened.prRepo)
  io.rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { runtimeId: 'a', capabilities: [] }
    }
    if (method === 'github.workItemDetails') {
      return fork
    }
    if (method === 'github.setPRFileViewed') {
      return true
    }
    throw new Error(`Unexpected targetless dispatch: ${method}`)
  })
  await act(async () => root.render(<Probe opened={opened} sourceContext={sourceContext} />))
  expect(view.details?.body).toBe('fork body')
  expect(view.error).toBeNull()
  expect(labels.error).toContain('Update Orca')
  expect(labels.data).toEqual([])
  await act(async () => {
    expect(await view.handlePRFileViewedChange('fork.ts', true)).toBe(true)
  })
  expect(
    io.rpc.mock.calls.filter(([, method]) => method === 'github.workItemDetails')
  ).toHaveLength(1)
  expect(io.rpc.mock.calls.some(([, method]) => method === 'github.listLabels')).toBe(false)
  expect(view.details?.pullRequestId).toBe('PR_fork')
})

async function freshExactIssueWrite(edit: Parameters<typeof runIssueUpdate>[0], owner: string) {
  io.rpc.mockClear()
  io.rpc.mockImplementation(async (_target, method, params) => {
    if (method === 'status.get') {
      return { runtimeId: 'fresh', capabilities: ['github.exact-work-item-target.v1'] }
    }
    if (method === 'github.updateIssue') {
      return updateIssue(
        '/clone',
        params.number,
        params.updates,
        null,
        {},
        io.preference,
        params.ownerRepo
      )
    }
    throw new Error(`Unexpected fresh operation: ${method}`)
  })
  await runIssueUpdate(edit)
  expect(io.rpc.mock.calls.map(([, method]) => method)).toEqual([
    'status.get',
    'github.updateIssue'
  ])
  expect(io.rpc.mock.calls[1][2]).toMatchObject({ ownerRepo: edit.issueRepo, number: 93 })
  expect(io.gh.mock.calls.map(([args]) => args)).toEqual([
    ['api', '-X', 'PATCH', `repos/${owner}/widgets/issues/93`, '--input', '-']
  ])
}

it('the actual old PR resolver fallback cannot authorize a generic writer', async () => {
  io.host = 'github.com'
  io.upstreamIsIssue = true
  const fork = await getWorkItemDetails('/clone', 93, 'pr', null, {}, 'upstream')
  expect(fork?.item.url).toContain('/fork/widgets/pull/93')
  expect(
    io.gh.mock.calls.some(([args]) => args[0] === 'pr' && args.includes('upstream/widgets'))
  ).toBe(true)
  expect(io.gh.mock.calls.some(([args]) => args.includes('repos/upstream/widgets/pulls/93'))).toBe(
    true
  )
  io.gh.mockClear()
  // This is the old generic writer boundary: it independently resolves upstream.
  await updateIssue('/clone', 93, { body: 'unsafe' }, null, {}, 'upstream')
  expect(io.gh.mock.calls.some(([args]) => args.includes('repos/upstream/widgets/issues/93'))).toBe(
    true
  )
  io.gh.mockClear()
  io.rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { runtimeId: 'a', capabilities: [] }
    }
    throw new Error('An unsupported generic write must not reach the old transport')
  })
  const edit = {
    repoPath: '/clone',
    repoId: 'clone',
    sourceContext: {
      kind: 'task-source',
      provider: 'github',
      projectId: 'p',
      hostId: 'runtime:paired',
      repoId: 'remote-clone'
    },
    projectOrigin: undefined,
    issueRepo: item('fork').prRepo,
    type: 'pr',
    number: 93,
    updates: { body: 'safe refusal' }
  } satisfies Parameters<typeof runIssueUpdate>[0]
  await expect(runIssueUpdate(edit)).rejects.toThrow('Update Orca')
  expect(io.gh).not.toHaveBeenCalled()
  expect(io.rpc.mock.calls.map(([, method]) => method)).toEqual(['status.get'])
  await freshExactIssueWrite(edit, 'fork')
})

it('publishes through the actual Tasks PR page and Project dialog using one accepted cache owner', async () => {
  io.host = 'github.com'
  const opened = item('fork')
  const projectOrigin = {
    owner: 'fork',
    repo: 'widgets',
    host: 'github.com',
    number: 93,
    type: 'pr' as const,
    projectId: 'p',
    projectItemId: 'row',
    cacheKey: 'p'
  }
  await act(async () =>
    root.render(
      <>
        <PullRequestPage workItem={opened} repoPath="/clone" onUse={() => {}} onClose={() => {}} />
        <GitHubItemDialog
          workItem={opened}
          repoPath="/clone"
          projectOrigin={projectOrigin}
          onUse={() => {}}
          onClose={() => {}}
        />
      </>
    )
  )
  const page = published.get('page')!
  const dialog = published.get('dialog')!
  expect(page.detailsCacheKey).toBe(dialog.detailsCacheKey)
  for (const consumer of [page, dialog]) {
    expect(consumer.details).toMatchObject({
      body: 'fork body',
      pullRequestId: 'PR_fork',
      headSha: 'fork-head',
      files: [{ path: 'fork.ts' }],
      checks: [{ name: 'fork check' }],
      comments: [{ body: 'fork conversation' }]
    })
  }
  await act(async () => patchCachedWorkItemBody(page.detailsCacheKey!, 'saved body'))
  expect(published.get('page')?.body).toBe('saved body')
  expect(published.get('dialog')?.body).toBe('saved body')
})

it('a matching issue read cannot authorize a later legacy write after source preference flips', async () => {
  io.host = 'github.com'
  const accepted = await getWorkItemWithRepository('/clone', 93, 'issue', null, {}, 'upstream')
  expect(accepted.item?.url).toContain('/upstream/widgets/issues/93')
  io.gh.mockClear()
  await updateIssue('/clone', 93, { body: 'would hit a different issue' }, null, {}, 'origin')
  expect(io.gh.mock.calls.some(([args]) => args.includes('repos/fork/widgets/issues/93'))).toBe(
    true
  )
  io.gh.mockClear()
  io.rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { runtimeId: 'a', capabilities: [] }
    }
    throw new Error('unsupported operation was dispatched')
  })
  const edit = {
    repoPath: '/clone',
    repoId: 'clone',
    sourceContext: {
      kind: 'task-source',
      provider: 'github',
      projectId: 'p',
      hostId: 'runtime:original',
      repoId: 'remote-clone'
    },
    projectOrigin: undefined,
    issueRepo: { owner: 'upstream', repo: 'widgets' },
    number: 93,
    updates: { body: 'edit' }
  } satisfies Parameters<typeof runIssueUpdate>[0]
  await expect(runIssueUpdate(edit)).rejects.toThrow('Update Orca')
  expect(io.rpc.mock.calls.map(([, method]) => method)).toEqual(['status.get'])
  expect(io.gh).not.toHaveBeenCalled()
  await freshExactIssueWrite(edit, 'upstream')
})
