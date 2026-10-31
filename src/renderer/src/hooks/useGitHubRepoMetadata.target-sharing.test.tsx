// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeCrashReportString } from '../../../shared/crash-report-redaction'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { useRepoAssignees, useRepoLabels } from './useGitHubRepoMetadata'
import { useGitHubOperationOwner } from './useGitHubOperationScope'
import { GitHubWorkItemTargetContext } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import { useGitHubWorkItemDetails } from '@/components/github-item-dialog/load-item-details/use-github-work-item-details'
import { listAssignableUsers, listLabels } from '../../../main/github/issue-field-options'
import { resolveGitHubRepoOperationOwner } from '@/lib/github-source-runtime-context'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { create } from 'zustand'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import type { RepoUpdate } from '@/store/repos/repo-state'
import {
  createRuntimeStatusSlice,
  clearRuntimeEnvironmentConnectionGenerationsForTests
} from '@/store/slices/runtime-status'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeStatusStoreState } from '@/store/slices/runtime-status-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import type { Repo } from '../../../shared/repo-types'
import { ROW_COUNT, registeredRows } from './github-metadata-registered-repos.test-fixture'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { resolveGitHubRepoExecution } from '../../../main/github/github-api-repository'

const provider = vi.hoisted(() => ({ exec: vi.fn(), rpc: vi.fn(), evaluations: 0, rows: 0 }))
const metadataStore = create<
  RuntimeStatusStoreState & {
    unrelated: number
    repos: Repo[]
    settings: GlobalSettings
    recordFeatureInteraction: () => void
    projects: []
    projectHostSetups: []
    folderWorkspacePathStatuses: {}
  }
>()((set, get) => ({
  ...createRuntimeStatusSlice(set, get),
  clientHostedBrowserCloseIntentsByEnvironment: {},
  clearClientHostedBrowserCloseIntents: () => {},
  unrelated: 0,
  projects: [],
  projectHostSetups: [],
  folderWorkspacePathStatuses: {},
  repos: registeredRows(),
  settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'S' }),
  recordFeatureInteraction: () => {}
}))
const repoActions = createRepoUpdateActions(
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this partial store includes every field the production account update reads; persistence is the only substituted boundary.
  ...([metadataStore.setState, metadataStore.getState] as unknown as Parameters<
    typeof createRepoUpdateActions
  >)
)
function updatedRow(target: RuntimeClientTarget, updates: RepoUpdate) {
  const host = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  const selected = metadataStore
    .getState()
    .repos.find((repo) => repo.id === 'shared' && repo.executionHostId === host)
  if (!selected) {
    throw new Error('missing persisted repo owner')
  }
  return { ...selected, ...updates }
}
function installRepoPersistence() {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: {
        update: async ({ updates }: { updates: RepoUpdate }) =>
          updatedRow({ kind: 'local' }, updates)
      }
    }
  })
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: ReturnType<typeof metadataStore.getState>) => unknown) =>
      metadataStore((state) => {
        provider.evaluations++
        const repos = new Proxy(state.repos, {
          get(target, key: Exclude<keyof Repo[], number> | `${number}`, _receiver: unknown) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              provider.rows++
            }
            return target[key]
          }
        })
        return select({ ...state, repos })
      }),
    { getState: () => metadataStore.getState() }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: provider.rpc,
  clearRuntimeCompatibilityCache: vi.fn(),
  clearRecentRuntimeCompatibilityFailure: vi.fn()
}))
vi.mock('../../../main/github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: provider.exec
}))
vi.mock('../../../main/github/github-api-repository', () => ({
  resolveGitHubRepoExecution: async (
    _path: string,
    ownerRepo: Parameters<typeof resolveGitHubRepoExecution>[1],
    _connection: unknown,
    options: Parameters<typeof resolveGitHubRepoExecution>[3]
  ) => ({ ownerRepo, ghOptions: options })
}))
const roots: ReturnType<typeof createRoot>[] = []
let server: Server | undefined
let configHome: string | undefined
const requests: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    )
  }
  server = undefined
  if (configHome) {
    await rm(configHome, { recursive: true, force: true })
  }
  configHome = undefined
  vi.unstubAllGlobals()
})

it.each([10, 100])(
  'shares actual paginated gh lists at N=%i with host-owned account/source and separate render/I/O/selector counts',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    installRepoPersistence()
    metadataStore.setState({ unrelated: 0, repos: registeredRows() })
    requests.length = 0
    provider.exec.mockReset()
    provider.rpc.mockReset()
    configHome = await mkdtemp(join(tmpdir(), 'orca-pr36172-gh-'))
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      requests.push(url.pathname + url.search)
      const page = url.searchParams.get('page') === '2' ? 2 : 1
      const [, host, account] = url.pathname.split('/')
      const value = `${host}-${account}-page${page}`
      if (page === 1) {
        const next = new URL(request.url ?? '/', base)
        next.searchParams.set('page', '2')
        response.setHeader('Link', `<${next}>; rel="next"`)
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify(
          url.pathname.endsWith('/labels') ? [{ name: value }] : [{ login: value, avatar_url: '' }]
        )
      )
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('fixture address missing')
    }
    const base = `http://127.0.0.1:${address.port}`
    const processes: {
      host: string
      account: string | undefined
      completed: boolean
      code?: number | null
      timedOut?: boolean
      stderr?: string
      error?: string
    }[] = []
    provider.exec.mockImplementation(
      async (args: string[], options: { ghAccount?: { user: string }; fixtureHost: string }) => {
        const observation: (typeof processes)[number] = {
          host: options.fixtureHost,
          account: options.ghAccount?.user,
          completed: false
        }
        processes.push(observation)
        try {
          expect(args).toContain('--paginate')
          const routed = args.map((arg) =>
            arg.startsWith('repos/')
              ? `${base}/${options.fixtureHost}/${options.ghAccount?.user}/${arg}`
              : arg
          )
          // Execute gh's real paginator/parser. Only the I/O URL and throwaway authentication are adapted.
          const result = await runProcess({
            program: 'gh',
            args: routed,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              GH_CONFIG_DIR: configHome,
              GH_TOKEN: 'fixture-token',
              GH_ENTERPRISE_TOKEN: 'fixture-token',
              GH_PROMPT_DISABLED: '1',
              GH_PAGER: 'cat'
            },
            timeoutMs: 10_000
          })
          Object.assign(observation, {
            code: result.code,
            timedOut: result.timedOut,
            stderr: sanitizeCrashReportString(result.stderr, 2000)
          })
          if (result.code !== 0 || result.timedOut) {
            throw new Error('gh fixture subprocess failed')
          }
          return { stdout: result.stdout }
        } catch (error) {
          observation.error = sanitizeCrashReportString(
            error instanceof Error ? error.message : String(error),
            2000
          )
          throw error
        } finally {
          observation.completed = true
        }
      }
    )
    const host = `github-${count}.corp`
    const source: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'p',
      hostId: 'runtime:S',
      repoId: 'shared'
    }
    const repository = { owner: 'fork', repo: 'widgets', host }
    const calls = { status: 0, labels: 0, users: 0, details: 0 }
    provider.rpc.mockImplementation(
      async (
        target: RuntimeClientTarget,
        method: string,
        args: { ownerRepo?: GitHubOwnerRepo; number: number; updates: RepoUpdate }
      ) => {
        if (method === 'repo.update') {
          return { repo: updatedRow(target, args.updates) }
        }
        expect(target).toEqual({ kind: 'environment', environmentId: 'S' })
        if (method === 'status.get') {
          calls.status++
          return { runtimeId: 'S', capabilities: ['github.exact-work-item-target.v1'] }
        }
        const { repo } = resolveGitHubRepoOperationOwner(metadataStore.getState(), {
          repoId: 'shared',
          target
        })
        expect(repo?.executionHostId).toBe('runtime:S')
        if (method === 'github.workItemDetails') {
          calls.details++
          return {
            item: {
              id: 'pr:93',
              repoId: 'shared',
              number: 93,
              type: 'pr',
              title: repo?.ghAccount?.user,
              url: `https://${host}/fork/widgets/pull/93`,
              prRepo: repository,
              state: 'open',
              labels: [],
              author: null,
              updatedAt: ''
            },
            body: repo?.ghAccount?.user,
            comments: []
          }
        }
        const options = { ghAccount: repo?.ghAccount, fixtureHost: 'S' }
        if (method === 'github.listLabels') {
          calls.labels++
          return listLabels(
            '/shared',
            repo?.issueSourcePreference,
            repo?.connectionId,
            options,
            args.ownerRepo
          )
        }
        if (method === 'github.listAssignableUsers') {
          calls.users++
          return listAssignableUsers(
            '/shared',
            repo?.issueSourcePreference,
            repo?.connectionId,
            options,
            args.ownerRepo
          )
        }
        throw new Error(`unexpected method ${method}`)
      }
    )
    const renders = new Map<string, number>()
    function Lists({ name }: { name: string }) {
      const labels = useRepoLabels('/shared', 'shared')
      const users = useRepoAssignees('/shared', 'shared')
      renders.set(name, (renders.get(name) ?? 0) + 1)
      return (
        <span data-list={name}>
          {labels.data.join(',')}:{users.data.map((user) => user.login).join(',')}
        </span>
      )
    }
    function Detail() {
      const view = useGitHubWorkItemDetails({
        workItem: {
          id: 'pr:93',
          repoId: 'shared',
          number: 93,
          type: 'pr',
          title: 'fork',
          url: `https://${host}/fork/widgets/pull/93`,
          prRepo: repository,
          state: 'open',
          labels: [],
          author: null,
          updatedAt: ''
        },
        repoPath: '/shared',
        effectiveRepoId: 'shared',
        sourceContext: source
      })
      return <output>{view.details?.body}</output>
    }
    const bound = (number: number) => ({
      resource: { repository, type: number % 2 ? ('pr' as const) : ('issue' as const), number },
      target: { kind: 'environment' as const, environmentId: 'S' },
      sourceContext: source
    })
    const contexts = Array.from({ length: count }, (_, index) => bound(index + 1))
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () =>
      root.render(
        <>
          <Detail />
          {Array.from({ length: count }, (_, index) => (
            <GitHubWorkItemTargetContext.Provider key={index} value={contexts[index]}>
              <Lists name={String(index)} />
            </GitHubWorkItemTargetContext.Provider>
          ))}
        </>
      )
    )
    async function loaded(account: string) {
      // External process completion must not wait on a render held inside this act.
      await vi.waitFor(
        () => {
          expect(
            processes.filter((entry) => entry.account === account && entry.completed)
          ).toHaveLength(2)
        },
        { timeout: 10_000 }
      )
      expect(
        processes.filter((entry) => entry.error || entry.code !== 0 || entry.timedOut),
        JSON.stringify(processes)
      ).toEqual([])
      await vi.waitFor(
        async () => {
          await act(async () => {})
          expect(container.querySelector('[data-list="0"]')?.textContent).toBe(
            `S-${account}-page1,S-${account}-page2:S-${account}-page1,S-${account}-page2`
          )
        },
        { timeout: 10_000 }
      )
      const pages = requests
        .map((path) => new URL(path, base))
        .filter((url) => url.pathname.startsWith(`/S/${account}/`))
      for (const kind of ['labels', 'assignees']) {
        const observed = pages.filter((url) => url.pathname.endsWith(`/${kind}`))
        expect(observed.map((url) => url.searchParams.get('page') ?? '1').sort()).toEqual([
          '1',
          '2'
        ])
        expect(
          observed.every((url) => url.pathname === `/S/${account}/repos/fork/widgets/${kind}`)
        ).toBe(true)
      }
    }
    await loaded('A')
    expect(container.querySelector('output')?.textContent).toBe('A')
    expect(calls).toEqual({ labels: 1, users: 1, details: 1, status: 3 })
    expect(provider.exec).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(4)
    const before = new Map(renders)
    const ioBefore = { ...calls }
    // Two owners per Lists plus Detail's identity/context owners, allowing a notification and consistency read each.
    const selectedOwners = 2 * count + 2
    const evaluationLimit = 2 * selectedOwners
    const rowReadLimit = 2 * selectedOwners * ROW_COUNT
    provider.evaluations = 0
    provider.rows = 0
    await act(async () => metadataStore.setState({ unrelated: count }))
    expect(renders).toEqual(before)
    expect(calls).toEqual(ioBefore)
    expect(provider.evaluations).toBeGreaterThanOrEqual(2 * count)
    expect(provider.evaluations).toBeLessThanOrEqual(evaluationLimit)
    // Numeric array reads observe the production resolver's actual scans, separately from selected-value evaluations/renders.
    expect(provider.rows).toBeGreaterThanOrEqual(2 * count * ROW_COUNT)
    expect(provider.rows).toBeLessThanOrEqual(rowReadLimit)
    for (const unusedHost of ['local', 'runtime:unused'] as const) {
      provider.evaluations = 0
      provider.rows = 0
      await act(async () => {
        expect(
          await repoActions.updateRepo(
            'shared',
            { ghAccount: { host, user: `unused-${count}` } },
            { hostId: unusedHost }
          )
        ).toBe(true)
      })
      expect(renders).toEqual(before)
      expect(calls).toEqual(ioBefore)
      expect(requests).toHaveLength(4)
      expect(provider.evaluations).toBeGreaterThanOrEqual(2 * count)
      expect(provider.evaluations).toBeLessThanOrEqual(evaluationLimit)
      expect(provider.rows).toBeGreaterThanOrEqual(2 * count * ROW_COUNT)
      expect(provider.rows).toBeLessThanOrEqual(rowReadLimit)
    }
    function RedundantOwnerSubscription() {
      useGitHubOperationOwner({ repoId: 'shared', repoPath: '/shared', sourceContext: source })
      return null
    }
    const redundantOwners = Array.from({ length: 4 * count }, () => ({ id: createBrowserUuid() }))
    const redundantRoot = createRoot(document.createElement('div'))
    try {
      await act(async () =>
        redundantRoot.render(
          redundantOwners.map((owner) => <RedundantOwnerSubscription key={owner.id} />)
        )
      )
      await act(async () => {})
      const outputBefore = container.textContent
      provider.evaluations = 0
      provider.rows = 0
      await act(async () => metadataStore.setState({ unrelated: count + 1 }))
      expect(container.textContent).toBe(outputBefore)
      expect(renders).toEqual(before)
      expect(calls).toEqual(ioBefore)
      expect(provider.exec).toHaveBeenCalledTimes(2)
      expect(requests).toHaveLength(4)
      // Extra real owner subscriptions must breach both budgets even when selected output and I/O stay equal.
      expect(provider.evaluations).toBeGreaterThan(evaluationLimit)
      expect(provider.rows).toBeGreaterThan(rowReadLimit)
    } finally {
      await act(async () => redundantRoot.unmount())
    }
    await act(async () => {
      expect(
        await repoActions.updateRepo(
          'shared',
          { ghAccount: { host, user: 'B' }, issueSourcePreference: 'upstream' },
          { hostId: 'runtime:S' }
        )
      ).toBe(true)
    })
    await loaded('B')
    expect(container.querySelector('output')?.textContent).toBe('B')
    expect(calls).toEqual({ labels: 2, users: 2, details: 2, status: 6 })
    expect(provider.exec).toHaveBeenCalledTimes(4)
    expect(requests).toHaveLength(8)
    expect(renders.get('0')).toBeGreaterThan(before.get('0')!)
    // Warm reopen and A re-entry reuse their own repository lists; B data never becomes A's list.
    await act(async () => {
      expect(
        await repoActions.updateRepo(
          'shared',
          { ghAccount: { host: 'github.corp', user: 'A' }, issueSourcePreference: 'origin' },
          { hostId: 'runtime:S' }
        )
      ).toBe(true)
    })
    await loaded('A')
    expect(provider.exec).toHaveBeenCalledTimes(4)
    expect(processes).toHaveLength(4)
    expect(calls).toEqual({ labels: 2, users: 2, details: 2, status: 6 })
    expect(requests).toHaveLength(8)
  }
)

function environment(revision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'S',
    name: 'S',
    createdAt: 1,
    updatedAt: revision,
    pairingRevision: revision,
    hostKeyFingerprint: 'fixture-host',
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-S', kind: 'websocket', label: 'fixture', endpoint: 'ws://fixture' }],
    preferredEndpointId: 'ws-S'
  }
}
function runtime(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  }
}
it('actual catalog and connected-to-connected status publishers wake the selected owner without an added authority subscription', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  metadataStore.setState({
    repos: registeredRows(),
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map()
  })
  metadataStore.getState().setRuntimeEnvironments([environment(1)])
  const { useGitHubOperationOwner } = await import('./useGitHubOperationScope')
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  let renders = 0
  function Scope() {
    const owner = useGitHubOperationOwner({
      repoId: 'shared',
      target: { kind: 'environment', environmentId: 'S' }
    })
    renders++
    return <output>{owner.scope}</output>
  }
  await act(async () => root.render(<Scope />))
  const initial = container.textContent
  await act(async () => metadataStore.getState().setRuntimeEnvironments([environment(2)]))
  expect(container.textContent).not.toBe(initial)
  const repaired = container.textContent
  await act(async () =>
    metadataStore
      .getState()
      .setRuntimeEnvironmentStatus(
        'S',
        { status: runtime('one'), checkedAt: 1 },
        { suppressDisconnectToast: true }
      )
  )
  const beforeMigration = renders
  await act(async () =>
    metadataStore
      .getState()
      .setRuntimeEnvironmentStatus(
        'S',
        { status: runtime('two'), checkedAt: 2 },
        { suppressDisconnectToast: true }
      )
  )
  expect(container.textContent).not.toBe(repaired)
  expect(renders).toBeGreaterThan(beforeMigration)
})

const pendingContext = {
  resource: {
    repository: { owner: 'fork', repo: 'widgets', host: 'pending.corp' },
    type: 'pr' as const,
    number: 93
  },
  target: { kind: 'environment' as const, environmentId: 'S' },
  sourceContext: {
    kind: 'task-source' as const,
    provider: 'github' as const,
    projectId: 'p',
    hostId: 'runtime:S' as const,
    repoId: 'shared'
  }
}

it('in-flight account A→B→A publishes only its own details/options and deduplicates the original A requests', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installRepoPersistence()
  metadataStore.setState({ repos: registeredRows() })
  const host = 'pending.corp'
  const repository = { owner: 'fork', repo: 'widgets', host }
  const source: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'p',
    hostId: 'runtime:S',
    repoId: 'shared'
  }
  const pending: { account: string; method: string; resolve: (value: unknown) => void }[] = []
  provider.rpc
    .mockReset()
    .mockImplementation(
      async (target: RuntimeClientTarget, method: string, args: { updates: RepoUpdate }) => {
        if (method === 'repo.update') {
          return { repo: updatedRow(target, args.updates) }
        }
        if (method === 'status.get') {
          return { runtimeId: 'S', capabilities: ['github.exact-work-item-target.v1'] }
        }
        const account = resolveGitHubRepoOperationOwner(metadataStore.getState(), {
          repoId: 'shared',
          target: { kind: 'environment', environmentId: 'S' }
        }).repo?.ghAccount?.user
        if (!account) {
          throw new Error('missing operation account')
        }
        return new Promise((resolve) => pending.push({ account, method, resolve }))
      }
    )
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  function Current() {
    const view = useGitHubWorkItemDetails({
      workItem: {
        id: 'pr:93',
        repoId: 'shared',
        number: 93,
        type: 'pr',
        title: 'fork',
        url: `https://${host}/fork/widgets/pull/93`,
        prRepo: repository,
        state: 'open',
        labels: [],
        author: null,
        updatedAt: ''
      },
      repoPath: '/shared',
      effectiveRepoId: 'shared',
      sourceContext: source
    })
    const lists = useRepoLabels('/shared', 'shared')
    return (
      <output>
        {view.details?.body ?? 'pending'}:{lists.data.join(',')}
      </output>
    )
  }
  await act(async () =>
    root.render(
      <GitHubWorkItemTargetContext.Provider value={pendingContext}>
        <Current />
      </GitHubWorkItemTargetContext.Provider>
    )
  )
  expect(pending.filter((entry) => entry.account === 'A')).toHaveLength(2)
  const change = async (user: string) =>
    act(async () => {
      expect(
        await repoActions.updateRepo(
          'shared',
          { ghAccount: { host: 'github.corp', user } },
          { hostId: 'runtime:S' }
        )
      ).toBe(true)
    })
  await change('B')
  expect(container.textContent).toBe('pending:')
  expect(pending.filter((entry) => entry.account === 'B')).toHaveLength(2)
  const finish = async (account: string) =>
    act(async () => {
      for (const entry of pending.filter((entry) => entry.account === account)) {
        entry.resolve(
          entry.method === 'github.listLabels'
            ? [account]
            : {
                item: {
                  id: 'pr:93',
                  type: 'pr',
                  number: 93,
                  title: account,
                  url: `https://${host}/fork/widgets/pull/93`,
                  prRepo: repository,
                  state: 'open',
                  labels: [],
                  author: null,
                  updatedAt: ''
                },
                body: account,
                comments: []
              }
        )
      }
    })
  await finish('A')
  expect(container.textContent).toBe('pending:')
  await change('A')
  expect(container.textContent).toBe('A:A')
  expect(pending).toHaveLength(4)
  await finish('B')
  expect(container.textContent).toBe('A:A')
  await change('B')
  expect(container.textContent).toBe('B:B')
  expect(pending).toHaveLength(4)
})

it.each([
  { sessionOnly: false, focus: null, revision: 101 },
  { sessionOnly: true, focus: 'B', revision: 102 }
])(
  'selects paired S before first render ($sessionOnly/$focus)',
  async ({ sessionOnly, focus, revision }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const { saveStoredWebRuntimeEnvironment, clearStoredWebRuntimeEnvironment } =
      await import('../web/web-runtime-environment')
    const { webRuntimeState } = await import('../web/preload-api/web-runtime-session')
    const { installWebPreloadApi } = await import('../web/web-preload-api')
    const root = createRoot(document.createElement('div'))
    try {
      clearStoredWebRuntimeEnvironment()
      const pairing = {
        ...environment(revision),
        ...(sessionOnly ? { sessionOnly: true as const } : {}),
        endpoints: environment(revision).endpoints.map((endpoint) => ({
          ...endpoint,
          deviceToken: 'fixture-token',
          publicKeyB64: 'fixture-key'
        }))
      }
      saveStoredWebRuntimeEnvironment(pairing)
      expect(window.localStorage.getItem('orca.web.runtimeEnvironment.v1') === null).toBe(
        sessionOnly
      )
      clearRuntimeEnvironmentConnectionGenerationsForTests()
      metadataStore.setState({
        repos: registeredRows(),
        settings: { ...metadataStore.getState().settings, activeRuntimeEnvironmentId: focus },
        runtimeEnvironments: [],
        runtimeStatusByEnvironmentId: new Map()
      })
      metadataStore.getState().setRuntimeEnvironments([environment(revision)])
      provider.rpc.mockReset().mockResolvedValue([`paired-${revision}`])
      Object.defineProperty(window, 'api', { configurable: true, writable: true, value: undefined })
      installWebPreloadApi()
      expect(webRuntimeState.activeEnvironment).toEqual(pairing)
      expect(webRuntimeState.activeEnvironment === pairing).toBe(sessionOnly)
      const observations: { target: RuntimeClientTarget; scope: string }[] = []
      let labels: string[] = []
      const target: RuntimeClientTarget = { kind: 'local' }
      function FirstScope() {
        const owner = useGitHubOperationOwner({ target, repoId: 'shared', repoPath: '/shared' })
        observations.push({ target: owner.target, scope: owner.scope })
        labels = useRepoLabels('/shared', 'shared', { target }).data
        return null
      }
      act(() => root.render(<FirstScope />))
      expect(observations[0]).toEqual({
        target: { kind: 'environment', environmentId: 'S' },
        scope: `["environment","S","shared","/shared","shared","/shared","runtime:S",null,{"host":"github.corp","user":"A"},"origin",null,${revision},0]`
      })
      await act(async () => {})
      expect(labels).toEqual([`paired-${revision}`])
      expect(provider.rpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'environment', environmentId: 'S' },
        'github.listLabels',
        { repo: 'shared' },
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: revision,
          expectedEnvironmentRuntimeId: undefined,
          beforeSend: expect.any(Function)
        }
      )
    } finally {
      act(() => root.unmount())
      clearStoredWebRuntimeEnvironment()
      webRuntimeState.activeEnvironment = null
      Reflect.deleteProperty(window, 'api')
      Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
    }
  }
)
