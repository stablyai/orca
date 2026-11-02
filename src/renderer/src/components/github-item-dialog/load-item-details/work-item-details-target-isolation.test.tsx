import '../../../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { act } from 'react'
import type * as GitRunner from '../../../../../main/git/runner'
import type { PRComment } from '../../../../../shared/github/comment-types'
// @vitest-environment happy-dom
import type {
  GitHubWorkItemDetails,
  GitHubWorkItem
} from '../../../../../shared/github/work-item-types'
import { listLabels } from '../../../../../main/github/issue-field-options'
import { useRepoLabels } from '@/hooks/useGitHubRepoMetadata'
import { GitHubWorkItemTargetContext } from './github-work-item-target-context'
import { updateIssue } from '../../../../../main/github/issue-update'
import { updatePullRequestBySlug } from '../../../../../main/github/project-view/pull-request-mutation'
import { updateIssueBySlug } from '../../../../../main/github/project-view/mutations'
import { listLabelsBySlug } from '../../../../../main/github/project-view/repository-field-options'
import {
  runWorkItemBodyUpdate,
  runIssueUpdate
} from '@/components/github/github-work-item-edit-mutations'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { WorkItemDetails } from '../../../../../shared/rpc-contract/github-repo-work-item-params'
import { getWorkItemDetails } from '../../../../../main/github/work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from '../../../../../main/github/github-api-repository'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import {
  workItemDetailsCache,
  patchCachedWorkItemBody,
  subscribeWorkItemDetailsCache
} from './work-item-details-cache'
import { useAppStore } from '@/store'
import { RpcDispatcher } from '../../../../../main/runtime/rpc/dispatcher'
import { OrcaRuntimeService } from '../../../../../main/runtime/orca-runtime'
import { RuntimeGitHubRepositoryQueryCommands } from '../../../../../main/runtime/runtime-github-repository-query-commands'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../../../../../main/runtime/rpc/methods/github-repo-work-item-methods'
import { RPC_PARAMS_BY_METHOD } from '../../../../../shared/rpc-contract/rpc-params-catalog.generated'
import { TASK_SOURCE_RUNTIME_CAPABILITIES } from '../../../../../shared/task-source-runtime-capabilities'
import { buildTaskSourceContextFromRepo } from '../../../../../shared/task-source-context'
import type { Repo } from '../../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

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

const io = vi.hoisted(() => {
  const target: { preference: 'upstream' | 'origin' } = { preference: 'upstream' }
  return {
    gh: vi.fn(),
    host: 'github.com',
    capable: true,
    rpc: vi.fn(),
    setViewed: vi.fn(),
    preference: target.preference,
    upstreamIsIssue: false,
    recordInteraction: vi.fn(),
    toastError: vi.fn(),
    unexpected: new Array<string>()
  }
})
vi.mock('../../../../../main/git/runner', async (original) => ({
  ...(await original<typeof GitRunner>()),
  ghExecFileAsync: io.gh
}))
vi.mock('../../../../../main/github/gh-utils', async () => ({
  ghExecFileAsync: io.gh,
  classifyGhError: () => ({ type: 'not_found', message: 'Not found' }),
  acquire: vi.fn(),
  release: vi.fn(),
  ...(await import('../../../../../main/github/github-repository-identity')),
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
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/github-slice-test-harness')
  return { useAppStore: createTestStore() }
})
vi.mock('sonner', () => ({ toast: { error: io.toastError } }))
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
function Metadata({ enabled }: { enabled: boolean }) {
  useRepoLabels(enabled ? '/clone' : null, enabled ? 'clone' : null)
  return null
}
let view: ReturnType<typeof useGitHubWorkItemDetails>
let root: ReturnType<typeof createRoot>
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
  useAppStore.setState({
    repos: [
      {
        id: 'clone',
        path: '/clone',
        displayName: 'Clone',
        badgeColor: '',
        addedAt: 0,
        issueSourcePreference: 'upstream'
      }
    ],
    recordFeatureInteraction: io.recordInteraction,
    runtimeStatusByEnvironmentId: new Map()
  })
  io.toastError.mockClear()
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
            parsed.ownerRepo,
            parsed.canonical
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
  vi.unstubAllGlobals()
  expect(io.unexpected).toEqual([])
})

it.each([false, true])(
  'keeps exact body, Project fields and slug options on their original runtime and ambient host credentials; capable=%s',
  async (capable) => {
    io.host = 'github.corp'
    io.capable = capable
    const opened = item('fork')
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'p',
      repoId: 'remote-clone',
      hostId: 'runtime:original'
    }
    const projectOrigin = {
      owner: 'fork',
      repo: 'widgets',
      host: io.host,
      number: 93,
      type: 'pr' as const,
      projectId: 'p',
      projectItemId: 'row',
      cacheKey: 'p'
    }
    io.rpc.mockImplementation(async (target, method, args) => {
      expect(target).toEqual({ kind: 'environment', environmentId: 'original' })
      if (method === 'github.project.updatePullRequestBySlug') {
        return updatePullRequestBySlug(args)
      }
      if (method === 'github.project.updateIssueBySlug') {
        return updateIssueBySlug(args)
      }
      if (method === 'github.project.listLabelsBySlug') {
        return listLabelsBySlug(args)
      }
      throw new Error(`exact operations must not preflight: ${method}`)
    })
    await runWorkItemBodyUpdate({
      item: opened,
      repoPath: '/clone',
      sourceContext,
      projectOrigin: undefined,
      body: 'exact body',
      parsedSlug: opened.prRepo!
    })
    await runIssueUpdate({
      repoPath: '/clone',
      repoId: 'clone',
      sourceContext,
      projectOrigin,
      number: 93,
      updates: { body: 'Project field' }
    })
    const options = await io.rpc(
      { kind: 'environment', environmentId: 'original' },
      'github.project.listLabelsBySlug',
      projectOrigin
    )
    expect(options).toMatchObject({ ok: true, labels: ['fork-label'] })
    expect(io.gh.mock.calls.some(([args]) => args.includes('repos/fork/widgets/pulls/93'))).toBe(
      true
    )
    expect(io.gh.mock.calls.some(([args]) => args.includes('repos/fork/widgets/issues/93'))).toBe(
      true
    )
    for (const [, execution] of io.gh.mock.calls) {
      expect(execution.host).toBe(io.host)
      expect(execution).not.toHaveProperty('cwd')
      expect(execution).not.toHaveProperty('ghAccount')
    }
    io.gh.mockRejectedValueOnce({ stderr: 'HTTP 403: permission denied', stdout: '' })
    await expect(
      runWorkItemBodyUpdate({
        item: opened,
        repoPath: '/clone',
        sourceContext,
        projectOrigin: undefined,
        body: 'denied',
        parsedSlug: opened.prRepo!
      })
    ).rejects.toThrow()
    io.gh.mockRejectedValueOnce({ stderr: 'HTTP 403: permission denied', stdout: '' })
    await expect(
      runIssueUpdate({
        repoPath: '/clone',
        repoId: 'clone',
        sourceContext,
        projectOrigin,
        number: 93,
        updates: { body: 'denied' }
      })
    ).rejects.toThrow()
    io.gh.mockRejectedValueOnce({ stderr: 'HTTP 403: permission denied', stdout: '' })
    expect(await listLabelsBySlug(projectOrigin)).toMatchObject({ ok: false })
  }
)

it('shared pending work and invalidation settle only their originating resource through a late same-number switch', async () => {
  io.host = 'github.com'
  const a = item('fork')
  const b = item('upstream')
  const fullA = await getWorkItemDetails('/clone', 93, 'pr', null, {}, 'upstream', a.prRepo)
  const fullB = await getWorkItemDetails('/clone', 93, 'pr', null, {}, 'upstream', b.prRepo)
  const pending: ((value: GitHubWorkItemDetails | null) => void)[] = []
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'p',
    hostId: 'runtime:paired',
    repoId: 'remote-clone'
  }
  io.rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { runtimeId: 'a', capabilities: [] }
    }
    if (method === 'github.workItemDetails') {
      return new Promise((resolve) => pending.push(resolve))
    }
    throw new Error(`unexpected ${method}`)
  })
  await act(async () =>
    root.render(<Probe opened={a} sourceContext={sourceContext} metadataEnabled={false} />)
  )
  const aKey = view.detailsCacheKey!
  await act(async () => view.invalidateCurrentDetailsCache())
  expect(pending).toHaveLength(2)
  await act(async () =>
    root.render(<Probe opened={b} sourceContext={sourceContext} metadataEnabled={false} />)
  )
  const bKey = view.detailsCacheKey!
  expect(bKey).not.toBe(aKey)
  expect(view.details).toBeNull()
  await act(async () => pending[0](fullA))
  expect(view.details).toBeNull()
  expect(workItemDetailsCache.get(bKey)?.pending).toBeDefined()
  await act(async () => {
    pending[1](fullA)
    pending[2](fullB)
  })
  expect(view.details).toMatchObject({ body: 'upstream body', pullRequestId: 'PR_upstream' })
  expect(workItemDetailsCache.get(aKey)?.details?.pullRequestId).toBe('PR_fork')
  expect(workItemDetailsCache.get(bKey)?.pending).toBeUndefined()
})

it('carries actual ordinary and Refresh intent through the registered full aggregate and publication owner', async () => {
  const registered: Repo = {
    id: 'clone',
    path: '/clone',
    displayName: 'Clone',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'runtime:details-intent',
    issueSourcePreference: 'upstream',
    ghAccount: { host: 'github.com', user: 'alice' }
  }
  useAppStore.setState({ repos: [registered] })
  const source = buildTaskSourceContextFromRepo({
    provider: 'github',
    projectId: 'clone',
    repo: registered
  })!
  const opened: GitHubWorkItem = {
    ...item('fork'),
    id: 'issue:93',
    type: 'issue',
    url: 'https://github.com/fork/widgets/issues/93'
  }
  const ownerRepo = { owner: 'fork', repo: 'widgets', host: 'github.com' }
  const commands = new RuntimeGitHubRepositoryQueryCommands({
    resolveRepo: async (selector) => {
      expect(selector).toBe('clone')
      return registered
    },
    getLocalGitArgs: () => [{ ghAccount: registered.ghAccount }]
  })
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('details-runtime')
  vi.spyOn(runtime, 'getRepoWorkItemDetails').mockImplementation(
    commands.getRepoWorkItemDetails.bind(commands)
  )
  const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_REPO_WORK_ITEM_METHODS })
  const intents: boolean[] = []
  io.rpc.mockImplementation(
    async (
      target: RuntimeClientTarget,
      method: string,
      params: unknown,
      options?: Parameters<typeof callRuntimeRpc>[3]
    ) => {
      expect(target).toEqual({ kind: 'environment', environmentId: 'details-intent' })
      options?.beforeSend?.()
      if (method === 'status.get') {
        return {
          runtimeId: 'details-runtime',
          capabilities: ['github.exact-work-item-target.v1', ...TASK_SOURCE_RUNTIME_CAPABILITIES]
        }
      }
      expect(method).toBe('github.workItemDetails')
      const parsed = RPC_PARAMS_BY_METHOD['github.workItemDetails'].parse(params)
      expect(parsed).toEqual({
        repo: 'clone',
        number: 93,
        type: 'issue',
        ownerRepo,
        canonical: parsed.canonical
      })
      expect(typeof parsed.canonical).toBe('boolean')
      intents.push(parsed.canonical === true)
      const reply = await dispatcher.dispatch({
        id: 'details',
        method,
        params,
        authToken: 'fixture'
      })
      if (!reply.ok) {
        throw new Error(reply.error.message)
      }
      return reply.result
    }
  )
  let failComments = true
  let body = 'ordinary body'
  const commentsFailure = new Error('same comments failure')
  let heldComments: ReturnType<typeof Promise.withResolvers<{ stdout: string }>> | undefined
  const commentsStarted = Promise.withResolvers<void>()
  io.gh.mockImplementation(
    async (args: string[], options: { ghAccount?: { host: string; user: string } }) => {
      expect(options.ghAccount).toEqual(registered.ghAccount)
      const route = args.find((arg) => arg.startsWith('repos/'))
      if (route) {
        expect(route).toMatch(/^repos\/fork\/widgets\/issues\/93(?:$|\/)/)
        if (route.includes('/comments?')) {
          if (heldComments) {
            commentsStarted.resolve()
            return heldComments.promise
          }
          if (failComments) {
            throw commentsFailure
          }
          return response([])
        }
        if (route.includes('/timeline?')) {
          return response([])
        }
        return response({
          number: 93,
          title: 'Exact fork',
          state: 'open',
          html_url: opened.url,
          user: null,
          labels: [],
          assignees: [],
          updated_at: '',
          body
        })
      }
      if (args.includes('graphql')) {
        return args.some((arg) => arg.includes('$includeItem'))
          ? response({})
          : response({ data: { repository: { issue: { participants: { nodes: [] } } } } })
      }
      throw new Error(`Unexpected gh command: ${JSON.stringify(args)}`)
    }
  )
  const legacy = await dispatcher.dispatch({
    id: 'shipped-absent-intent',
    method: 'github.workItemDetails',
    authToken: 'fixture',
    params: { repo: 'clone', number: 93, type: 'issue', ownerRepo }
  })
  expect(legacy).toMatchObject({ ok: true, result: { comments: [], item: { url: opened.url } } })
  let current!: ReturnType<typeof useGitHubWorkItemDetails>
  function Issue() {
    current = useGitHubWorkItemDetails({
      workItem: opened,
      repoPath: '/clone',
      effectiveRepoId: 'clone',
      sourceContext: source
    })
    return (
      <output>
        {current.details?.body}|{current.error}|{current.refreshing ? 'loading' : 'idle'}
      </output>
    )
  }
  await act(async () => root.render(<Issue />))
  expect(intents).toEqual([false])
  expect(current.details?.comments).toEqual([])
  expect(current.details?.item.url).toBe(opened.url)
  expect(current.error).toBeNull()
  const prior = current.details
  await act(async () => current.refreshTask())
  expect(intents).toEqual([false, true])
  expect(current.details).toBe(prior)
  expect(current.error).toBeNull()
  expect(current.refreshing).toBe(false)
  expect(io.toastError).toHaveBeenCalledExactlyOnceWith('Unable to refresh this task. Try again.')
  failComments = false
  body = 'strict body'
  await act(async () => current.refreshTask())
  expect(intents).toEqual([false, true, true])
  expect(current.details?.body).toBe('strict body')
  expect(current.acceptedRefresh).toBe(1)
  expect(current.details?.item.url).toBe(opened.url)
  expect(io.toastError).toHaveBeenCalledTimes(1)
  const changedBodies: (string | undefined)[] = []
  const unsubscribe = subscribeWorkItemDetailsCache(() => {
    changedBodies.push(workItemDetailsCache.get(current.detailsCacheKey!)?.details?.body)
  })
  heldComments = Promise.withResolvers<{ stdout: string }>()
  body = 'superseded body'
  let crossed!: Promise<void>
  await act(async () => {
    crossed = current.refreshTask()
    await commentsStarted.promise
  })
  await act(async () => {
    patchCachedWorkItemBody(current.detailsCacheKey!, 'saved body')
    body = 'saved body'
    const held = heldComments!
    heldComments = undefined
    held.resolve(response([]))
    await crossed
  })
  unsubscribe()
  expect(intents).toEqual([false, true, true, true, true])
  expect(current.acceptedRefresh).toBe(2)
  expect(current.details?.body).toBe('saved body')
  expect(changedBodies).not.toContain('superseded body')
  expect(io.toastError).toHaveBeenCalledTimes(1)
  const strictComments = io.gh.mock.calls.filter(([args]) =>
    args.some((arg: string) => arg.includes('/comments?'))
  )
  expect(strictComments).toHaveLength(6)
  expect(strictComments[0][0]).toContain('--cache')
  expect(strictComments[1][0]).toContain('--cache')
  for (const [args] of strictComments.slice(2)) {
    expect(args).not.toContain('--cache')
    expect(args).toEqual(expect.arrayContaining(['--paginate', '--slurp']))
  }
})
