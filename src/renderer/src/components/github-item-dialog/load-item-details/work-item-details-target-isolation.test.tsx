import '../../../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import {
  workItemDetailsProvider,
  accountCaptureProvider,
  accountCaptureAccounts,
  accountCaptureRepo,
  workItemDetailsItem,
  useWorkItemDetailsProbe,
  response
} from './work-item-details-provider.test-fixture'
import { act } from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  closeTestStores,
  makeRepo,
  testState
} from '../../../../../main/persistence/persistence-test-harness'
import { installGitHubProjectAccounts } from '../../../../../main/github/github-project-account'
import { GITHUB_PULL_REQUEST_METHODS } from '../../../../../main/runtime/rpc/methods/github-pull-request-methods'
import { clearRuntimeCompatibilityCache } from '@/runtime/runtime-compatibility-cache'

import type * as GitRunner from '../../../../../main/git/runner'
import type * as GitHubClient from '../../../../../main/github/client'
import type { WorkItemDetailsPublished as Published } from './work-item-details-provider.test-fixture'
// @vitest-environment happy-dom
import type {
  GitHubWorkItemDetails,
  GitHubWorkItem
} from '../../../../../shared/github/work-item-types'
import { listLabels } from '../../../../../main/github/issue-field-options'
import { useRepoLabels, useRepoAssignees } from '@/hooks/useGitHubRepoMetadata'
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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { WorkItemDetails } from '../../../../../shared/rpc-contract/github-repo-work-item-params'
import { getWorkItemDetails } from '../../../../../main/github/work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from '../../../../../main/github/github-api-repository'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import {
  workItemDetailsCache,
  patchCachedWorkItemBody,
  subscribeWorkItemDetailsCache,
  invalidateWorkItemDetailsCacheForKey
} from './work-item-details-cache'
import { useAppStore } from '@/store'
import { RpcDispatcher } from '../../../../../main/runtime/rpc/dispatcher'
import { OrcaRuntimeService } from '../../../../../main/runtime/orca-runtime'
import { RuntimeGitHubRepositoryQueryCommands } from '../../../../../main/runtime/runtime-github-repository-query-commands'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../../../../../main/runtime/rpc/methods/github-repo-work-item-methods'
import { RPC_PARAMS_BY_METHOD } from '../../../../../shared/rpc-contract/rpc-params-catalog.generated'
import {
  TASK_SOURCE_RUNTIME_CAPABILITIES,
  GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY
} from '../../../../../shared/task-source-runtime-capabilities'
import { buildTaskSourceContextFromRepo } from '../../../../../shared/task-source-context'
import type { Repo } from '../../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'

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
vi.mock('../../../../../main/github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClient>()),
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

function item(owner: string): GitHubWorkItem {
  return workItemDetailsItem(owner, io.host)
}
let view: ReturnType<typeof useGitHubWorkItemDetails>
let root: ReturnType<typeof createRoot>
function Probe(args: Omit<Parameters<typeof useWorkItemDetailsProbe>[0], 'publish'>) {
  return useWorkItemDetailsProbe({
    ...args,
    publish: (next) => {
      view = next
    }
  })
}

let actualCallRuntimeRpc: typeof RuntimeRpcClient.callRuntimeRpc
beforeAll(async () => {
  actualCallRuntimeRpc = (
    await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  ).callRuntimeRpc
})

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
  io.gh.mockReset().mockImplementation(workItemDetailsProvider(io, item))
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
            parsed.canonical,
            parsed.expectedGhAccount
          )
        },
        listLabels: async (args: Parameters<typeof window.api.gh.listLabels>[0]) =>
          listLabels(args.repoPath, 'upstream', null, {}, args.ownerRepo, args.expectedGhAccount),
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
        canonical: parsed.canonical,
        expectedGhAccount: registered.ghAccount
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
  const changedAccount = { ...registered, ghAccount: { host: 'github.com', user: 'bob' } }
  const releaseAccount = installGitHubProjectAccounts({ getRepos: () => [changedAccount] })
  try {
    io.gh.mockClear()
    const priorMismatch = current.details
    const failures = io.toastError.mock.calls.length
    await act(async () => current.refreshTask())
    expect(intents.at(-1)).toBe(true)
    expect(io.gh).not.toHaveBeenCalled()
    expect(current.details).toBe(priorMismatch)
    expect(current.refreshing).toBe(false)
    expect(io.toastError).toHaveBeenCalledTimes(failures + 1)
  } finally {
    releaseAccount()
  }
})

it('keeps the captured account through held status, real host selection, metadata and Viewed settlement', async () => {
  const { alice, bob } = accountCaptureAccounts
  const registered = accountCaptureRepo
  const source = buildTaskSourceContextFromRepo({
    provider: 'github',
    projectId: 'clone',
    repo: registered
  })!
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr36172-capture-'))
  const hostStore = createStore()
  hostStore.addRepo(makeRepo({ id: 'clone', path: '/clone', ghAccount: alice }))
  const releaseAccount = installGitHubProjectAccounts(hostStore)
  const runtime = new OrcaRuntimeService(hostStore)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('capture-runtime')
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...GITHUB_REPO_WORK_ITEM_METHODS, ...GITHUB_PULL_REQUEST_METHODS]
  })
  io.rpc.mockImplementation(actualCallRuntimeRpc)
  clearRuntimeCompatibilityCache()
  let statusGate: ReturnType<typeof Promise.withResolvers<void>> | undefined =
    Promise.withResolvers<void>()
  let statusEntered = Promise.withResolvers<void>()
  let advertiseAccount = true
  const remote = vi.fn(async (args: Parameters<typeof window.api.runtimeEnvironments.call>[0]) => {
    if (args.method === 'status.get') {
      const original = runtime.getStatus()
      const snapshot = {
        ...original,
        runtimeId: runtime.getRuntimeId(),
        capabilities: original.capabilities?.filter(
          (capability) =>
            advertiseAccount || capability !== GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY
        )
      }
      const gate = statusGate
      statusEntered.resolve()
      await gate?.promise
      return { id: 'status', ok: true, result: snapshot }
    }
    expect(args.expectedEnvironmentRuntimeId).toBe('capture-runtime')
    return dispatcher.dispatch({
      id: 'capture',
      authToken: 'fixture',
      method: args.method,
      params: args.params
    })
  })
  Object.defineProperty(window.api, 'runtimeEnvironments', {
    configurable: true,
    value: { call: remote }
  })
  const terminal = io.gh.getMockImplementation()!
  io.gh.mockImplementation(accountCaptureProvider(terminal))
  let current!: ReturnType<typeof useGitHubWorkItemDetails>
  let labels!: ReturnType<typeof useRepoLabels>
  let assignees!: ReturnType<typeof useRepoAssignees>
  const opened = item('fork')
  function Options() {
    labels = useRepoLabels('/clone', 'clone')
    assignees = useRepoAssignees('/clone', 'clone')
    return null
  }
  function Dialog() {
    current = useGitHubWorkItemDetails({
      workItem: opened,
      repoPath: '/clone',
      effectiveRepoId: 'clone',
      sourceContext: source
    })
    return (
      <GitHubWorkItemTargetContext.Provider value={current.targetContext}>
        <Options />
      </GitHubWorkItemTargetContext.Provider>
    )
  }
  try {
    useAppStore.setState({ repos: [registered] })
    await act(async () => root.render(<Dialog />))
    await statusEntered.promise
    const aKey = current.detailsCacheKey!
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: bob })
    await act(async () => {
      statusGate?.resolve()
      statusGate = undefined
    })
    expect(current.error).toContain('GitHub account changed')
    expect(current.details).toBeNull()
    expect(labels.error).toContain('GitHub account changed')
    expect(assignees.error).toContain('GitHub account changed')
    expect(labels.data).toEqual([])
    expect(assignees.data).toEqual([])
    expect(io.gh).not.toHaveBeenCalled()
    expect(
      remote.mock.calls
        .filter(([args]) => args.method !== 'status.get')
        .map(([args]) => args.params)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'pr', canonical: false, expectedGhAccount: alice }),
        expect.objectContaining({ expectedGhAccount: alice, ownerRepo: opened.prRepo })
      ])
    )
    await act(async () => useAppStore.setState({ repos: [{ ...registered, ghAccount: bob }] }))
    const bKey = current.detailsCacheKey!
    expect(current.details?.body).toBe('fork body')
    expect(current.error).toBeNull()
    expect(labels.data).toEqual(['fork-label'])
    expect(assignees.data).toEqual([{ login: 'assignee', name: null, avatarUrl: '' }])
    expect(io.gh.mock.calls.every(([, options]) => options.ghAccount?.user === 'bob')).toBe(true)

    // A new legitimate A demand captures A before the provider is held; later B cannot cancel it.
    const providerEntered = Promise.withResolvers<void>()
    const providerGate = Promise.withResolvers<void>()
    const nextTerminal = io.gh.getMockImplementation()!
    io.gh.mockImplementationOnce(async (...args) => {
      providerEntered.resolve()
      await providerGate.promise
      return nextTerminal(...args)
    })
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: alice })
    await act(async () => {
      invalidateWorkItemDetailsCacheForKey(aKey)
      useAppStore.setState({ repos: [registered] })
    })
    await providerEntered.promise
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: bob })
    await act(async () => useAppStore.setState({ repos: [{ ...registered, ghAccount: bob }] }))
    const bDetails = current.details
    await act(async () => providerGate.resolve())
    expect(workItemDetailsCache.get(aKey)?.details?.body).toBe('fork body')
    expect(workItemDetailsCache.get(aKey)?.pending).toBeUndefined()
    expect(current.detailsCacheKey).toBe(bKey)
    expect(current.details).toBe(bDetails)

    // Viewed selects its payload after its existing compatibility wait, then uses the same capture guard.
    clearRuntimeCompatibilityCache()
    statusGate = Promise.withResolvers<void>()
    statusEntered = Promise.withResolvers<void>()
    let click!: Promise<boolean>
    await act(async () => {
      click = current.handlePRFileViewedChange('fork.ts', true)
      await statusEntered.promise
    })
    expect(current.details?.files?.[0].viewerViewedState).toBe('VIEWED')
    const readsBeforeRelease = remote.mock.calls.length
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: alice })
    io.gh.mockClear()
    await act(async () => {
      statusGate?.resolve()
      statusGate = undefined
      expect(await click).toBe(false)
    })
    expect(io.gh).not.toHaveBeenCalled()
    expect(remote.mock.calls.slice(readsBeforeRelease).map(([args]) => args.method)).toEqual([
      'github.setPRFileViewed'
    ])
    expect(remote.mock.calls.at(-1)?.[0].params).toMatchObject({ expectedGhAccount: bob })
    expect(current.details?.files?.[0].viewerViewedState).toBe('UNVIEWED')
    expect(current.pendingViewedPaths.size).toBe(0)
    expect(io.toastError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('GitHub account changed')
    )
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: bob })
    await act(async () => {
      expect(await current.handlePRFileViewedChange('fork.ts', true)).toBe(true)
    })
    expect(current.details?.files?.[0].viewerViewedState).toBe('VIEWED')
    expect(current.pendingViewedPaths.size).toBe(0)
    expect(io.gh).toHaveBeenCalled()
    expect(io.gh.mock.calls.every(([, options]) => options.ghAccount?.user === 'bob')).toBe(true)
    // Undeclared servers keep working, with the approved existing account-switch limitation.
    advertiseAccount = false
    clearRuntimeCompatibilityCache()
    hostStore.updateRepo({ id: 'clone' }, { ghAccount: alice })
    io.gh.mockClear()
    await act(async () => {
      expect(await current.handlePRFileViewedChange('fork.ts', false)).toBe(true)
    })
    expect(remote.mock.calls.at(-1)?.[0].params).not.toHaveProperty('expectedGhAccount')
    expect(io.gh.mock.calls.every(([, options]) => options.ghAccount?.user === 'alice')).toBe(true)
    expect(current.pendingViewedPaths.size).toBe(0)
  } finally {
    statusGate?.resolve()
    releaseAccount()
    clearRuntimeCompatibilityCache()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  }
})
