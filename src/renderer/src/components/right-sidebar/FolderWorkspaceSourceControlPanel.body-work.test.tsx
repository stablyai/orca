// @vitest-environment happy-dom
import { act, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as WorktreeGitCopy from '@/lib/worktree-git-copy'
import type * as GitStatusClient from '@/runtime/runtime-git-status-client'
import type * as GitDiffClient from '@/runtime/runtime-git-diff-client'
import type * as RepoClient from '@/runtime/runtime-repo-client'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import FolderWorkspaceSourceControlPanel from './FolderWorkspaceSourceControlPanel'
import { SourceControlPanel } from './source-control/panel/panel'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { createRunningCommitMessageGenerationRecord } from '@/store/slices/commit-message-generation'
import type { PullRequestGenerationRecord } from '@/store/slices/pull-request-generation-state'

const probes = vi.hoisted(() => ({
  status: vi.fn(),
  upstreamRef: vi.fn(),
  compare: vi.fn(),
  history: vi.fn(),
  submodules: vi.fn(),
  upstream: vi.fn(),
  eligibility: vi.fn(),
  visible: new Set<string>()
}))
const pending = (): Promise<never> => new Promise(() => {})

vi.mock('./source-control/sync/git-status-refresh', () => ({
  refreshGitStatusForWorktree: async (args: {
    worktreeId: string
    request?: { onStatusAccepted?: (status: unknown) => void }
  }) => {
    probes.status(args.worktreeId)
    args.request?.onStatusAccepted?.({
      entries: [],
      conflictOperation: 'unknown',
      branch: 'refs/heads/feature',
      upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 0 }
    })
  }
}))
vi.mock('./source-control/sync/use-refresh-on-host-contact', () => ({
  useRefreshOnHostContact: () => {}
}))
vi.mock('@/lib/worktree-git-copy', async (original) => ({
  ...(await original<typeof WorktreeGitCopy>()),
  resolveWorktreeGitCopyNow: (id: string, hostId: string) => ({
    worktreeId: id,
    hostId,
    transport: { kind: 'local' }
  })
}))
vi.mock('@/runtime/runtime-git-status-client', async (original) => ({
  ...(await original<typeof GitStatusClient>()),
  setRuntimeGitStatusUpstreamRefWatch: async (context: { worktreeId: string }) =>
    probes.upstreamRef(context.worktreeId),
  getRuntimeGitHistory: (context: { worktreeId: string }) => {
    probes.history(context.worktreeId)
    return pending()
  },
  getRuntimeGitSubmoduleStatus: (context: { worktreeId: string }) => {
    probes.submodules(context.worktreeId)
    return pending()
  }
}))
vi.mock('@/runtime/runtime-git-diff-client', async (original) => ({
  ...(await original<typeof GitDiffClient>()),
  getRuntimeGitBranchCompare: async (context: { worktreeId: string }, baseRef: string) => {
    probes.compare(context.worktreeId)
    return {
      summary: {
        baseRef,
        baseOid: 'base',
        compareRef: 'feature',
        headOid: 'head',
        mergeBase: 'base',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    }
  }
}))
vi.mock('@/runtime/runtime-repo-client', async (original) => ({
  ...(await original<typeof RepoClient>()),
  watchRuntimeRepoBaseRefDefault: () => () => {}
}))

// Report a section on screen only when the test made it visible, as a scrolled sidebar would.
const observed = new Map<Element, IntersectionObserver>()
class ViewportIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  constructor(private readonly callback: IntersectionObserverCallback) {}
  report(target: Element): void {
    const id = target.getAttribute('data-source-control-worktree') ?? ''
    const bounds = target.getBoundingClientRect()
    const entry: IntersectionObserverEntry = {
      target,
      isIntersecting: probes.visible.has(id),
      boundingClientRect: bounds,
      intersectionRect: bounds,
      rootBounds: bounds,
      intersectionRatio: probes.visible.has(id) ? 1 : 0,
      time: performance.now()
    }
    this.callback([entry], this)
  }
  observe(target: Element): void {
    observed.set(target, this)
    this.report(target)
  }
  unobserve(target: Element): void {
    observed.delete(target)
  }
  disconnect(): void {
    for (const [target, observer] of observed) {
      if (observer === this) {
        observed.delete(target)
      }
    }
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
async function scrollTo(ids: readonly string[]): Promise<void> {
  probes.visible.clear()
  for (const id of ids) {
    probes.visible.add(id)
  }
  await act(async () => {
    for (const [target, observer] of observed) {
      if (observer instanceof ViewportIntersectionObserver) {
        observer.report(target)
      }
    }
  })
}
function writeUnrelatedGeneration(): void {
  const context = {
    worktreeId: 'other::/elsewhere',
    worktreePath: '/elsewhere',
    requestId: 1,
    runtimeTarget: { kind: 'local' as const }
  }
  const pr: PullRequestGenerationRecord = {
    context: { ...context, repoId: 'other', branch: 'other' },
    seed: { base: 'main', title: '', body: '', draft: false },
    seedFieldRevisions: { base: 0, title: 0, body: 0, draft: 0 },
    requiresPushBeforeCreate: false,
    status: 'running',
    result: null,
    error: null,
    hydrated: false
  }
  useAppStore
    .getState()
    .setCommitMessageGenerationRecord(
      context.worktreeId,
      createRunningCommitMessageGenerationRecord(context)
    )
  useAppStore.getState().setPullRequestGenerationRecord(context.worktreeId, pr)
}

const BODY_OPERATIONS = ['compare', 'history', 'submodules', 'upstream', 'eligibility'] as const
let root: Root
let container: HTMLDivElement
let renders = 0
const refuseConfirmation = async () => false

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', ViewportIntersectionObserver)
  const namespace = new Proxy(
    {},
    {
      get: (_target, method) =>
        typeof method === 'string' && method.startsWith('on') ? () => () => {} : pending
    }
  )
  vi.stubGlobal('api', new Proxy({}, { get: () => namespace }))
  vi.useFakeTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  for (const probe of Object.values(probes)) {
    if (typeof probe === 'function') {
      probe.mockClear()
    }
  }
  probes.visible.clear()
  observed.clear()
  renders = 0
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(count: number): Worktree[] {
  const worktrees: Worktree[] = Array.from({ length: count }, (_, i) => ({
    id: `repo::/child-${i}`,
    repoId: 'repo',
    path: `/child-${i}`,
    branch: `refs/heads/feature-${i}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    displayName: `Child ${i}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: i,
    lastActivityAt: 0,
    hostId: 'local' as const,
    instanceId: `instance-${i}`
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the catalog, status and probed actions the panels read.
  useAppStore.setState({
    activeWorktreeId: 'folder:feature',
    activeWorkspaceKey: 'folder:feature',
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    repos: [
      {
        id: 'repo',
        displayName: 'Child',
        path: '/repo',
        kind: 'git',
        worktreeBaseRef: 'origin/main'
      }
    ],
    worktreesByRepo: { repo: worktrees },
    folderWorkspaces: [
      { id: 'feature', name: 'Feature', folderPath: '/folder', projectGroupId: 'group' }
    ],
    workspaceLineageByChildKey: Object.fromEntries(
      worktrees.map((row, i) => [
        row.id,
        {
          childWorkspaceKey: `worktree:${row.id}`,
          childInstanceId: row.instanceId,
          parentWorkspaceKey: 'folder:feature',
          parentInstanceId: null,
          createdAt: i
        }
      ])
    ),
    // Changed sections start expanded, so every body would mount without the viewport gate.
    gitStatusByWorktree: Object.fromEntries(
      worktrees.map((row) => [row.id, [{ path: 'a.ts', status: 'modified', area: 'unstaged' }]])
    ),
    fetchUpstreamStatus: async (worktreeId: string) => {
      probes.upstream(worktreeId)
    },
    getHostedReviewCreationEligibility: (args: { worktreePath?: string }) => {
      probes.eligibility(args.worktreePath)
      return pending()
    },
    fetchHostedReviewForBranch: async () => null,
    fetchPRForBranch: async () => null
  } as unknown as Partial<AppState>)
  return worktrees
}

async function render(node: ReactNode): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmationDialogContext.Provider value={refuseConfirmation}>
        <TooltipProvider>
          <Profiler id="source-control" onRender={() => (renders += 1)}>
            {node}
          </Profiler>
        </TooltipProvider>
      </ConfirmationDialogContext.Provider>
    )
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function bodyWork(worktrees: readonly Worktree[]) {
  const idByPath = new Map(worktrees.map((row) => [row.path, row.id]))
  return Object.fromEntries(
    BODY_OPERATIONS.map((operation) => {
      const ids = probes[operation].mock.calls.map(
        ([key]: unknown[]) => idByPath.get(String(key)) ?? String(key)
      )
      return [operation, { calls: ids.length, worktrees: [...new Set(ids)].sort() }]
    })
  )
}

it('runs expanded body work only for on-screen sections, at mount and over the safety interval', async () => {
  const counts: unknown[] = []
  for (const count of [3, 30]) {
    useAppStore.setState(useAppStore.getInitialState(), true)
    const worktrees = setup(count)
    const visible = [worktrees[0]!.id, worktrees[1]!.id]
    probes.visible.clear()
    for (const id of visible) {
      probes.visible.add(id)
    }
    for (const probe of [probes.upstreamRef, ...BODY_OPERATIONS.map((name) => probes[name])]) {
      probe.mockClear()
    }
    await render(<FolderWorkspaceSourceControlPanel />)
    const atMount = bodyWork(worktrees)
    expect(atMount.upstream!.calls).toBeGreaterThan(0)
    const intervals = []
    for (let tick = 0; tick < 2; tick++) {
      for (const operation of BODY_OPERATIONS) {
        probes[operation].mockClear()
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      intervals.push(bodyWork(worktrees))
    }
    for (const snapshot of [atMount, ...intervals]) {
      for (const work of Object.values(snapshot)) {
        expect(work.worktrees.every((id) => visible.includes(id))).toBe(true)
        expect(work.calls).toBeLessThanOrEqual(visible.length)
      }
    }
    // Only the selected worktree binds an upstream ref; sections never add resolutions.
    expect(probes.upstreamRef).not.toHaveBeenCalled()
    counts.push({ atMount, intervals })
    await act(async () => root.render(null))
  }
  // Ten times the attached worktrees costs the same when the same sections are on screen.
  expect(counts[1]).toEqual(counts[0])
})

it.each([3, 30])(
  'keeps %i section bodies idle when another worktree writes generation records or its row churns',
  async (count) => {
    const worktrees = setup(count)
    for (const row of worktrees) {
      probes.visible.add(row.id)
    }
    await render(<FolderWorkspaceSourceControlPanel />)
    expect(probes.eligibility).toHaveBeenCalled()
    probes.eligibility.mockClear()
    renders = 0
    await act(async () => writeUnrelatedGeneration())
    expect(probes.eligibility).not.toHaveBeenCalled()
    expect(renders).toBe(0)

    probes.upstream.mockClear()
    await act(async () =>
      useAppStore.setState((state) => ({
        worktreesByRepo: {
          repo: state.worktreesByRepo.repo!.map((row, index) =>
            index === 0 ? { ...row, lastActivityAt: 99 } : row
          )
        }
      }))
    )
    // A new record with the same routing fields refetches nothing.
    expect(probes.upstream).not.toHaveBeenCalled()
    expect(probes.eligibility).not.toHaveBeenCalled()
  }
)

it('keeps the selected workspace panel idle when another worktree writes generation records', async () => {
  const [worktree] = setup(1)
  useAppStore.setState({
    activeWorktreeId: worktree!.id,
    activeWorkspaceKey: `worktree:${worktree!.id}`
  })
  await render(<SourceControlPanel />)
  expect(probes.eligibility).toHaveBeenCalled()
  probes.eligibility.mockClear()
  renders = 0
  await act(async () => writeUnrelatedGeneration())
  expect(probes.eligibility).not.toHaveBeenCalled()
  expect(renders).toBe(0)
})

it("keeps a section's selection across scrolling away and back while its Git work stops", async () => {
  const worktrees = setup(3)
  const [first] = worktrees
  await scrollTo([first!.id])
  await render(<FolderWorkspaceSourceControlPanel />)
  const section = container.querySelector(`[data-source-control-worktree="${first!.id}"]`)
  const row = section?.querySelector('[data-testid="source-control-entry"]')
  expect(row).toBeTruthy()
  // Both modifiers select on either platform without triggering split open.
  await act(async () =>
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, metaKey: true }))
  )
  expect(section?.textContent).toContain('1 selected')

  await scrollTo([])
  for (const operation of BODY_OPERATIONS) {
    probes[operation].mockClear()
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  // A mounted but off-screen body keeps its view and runs nothing.
  for (const operation of BODY_OPERATIONS) {
    expect(probes[operation]).not.toHaveBeenCalled()
  }

  await scrollTo([first!.id])
  expect(section?.textContent).toContain('1 selected')
})
