import { getDefaultSettings } from '../../../../shared/constants'
// @vitest-environment happy-dom
import { act, Profiler, type ReactNode } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as WorktreeGitCopy from '@/lib/worktree-git-copy'
import type * as GitStatusClient from '@/runtime/source-control/git/runtime-git-status-client'
import type * as GitDiffClient from '@/runtime/source-control/git/runtime-git-diff-client'
import type * as PanelModule from './source-control/panel/panel'
import type * as RepoClient from '@/runtime/runtime-repo-client'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import FolderWorkspaceSourceControlPanel from './FolderWorkspaceSourceControlPanel'
import { SourceControlPanel } from './source-control/panel/panel'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { createRunningCommitMessageGenerationRecord } from '@/store/slices/commit-message-generation'
import type { PullRequestGenerationRecord } from '@/store/slices/hosted-review/generation/pull-request-generation-state'

const probes = vi.hoisted(() => ({
  status: vi.fn(),
  upstreamRef: vi.fn(),
  compare: vi.fn(),
  history: vi.fn(),
  submodules: vi.fn(),
  upstream: vi.fn(),
  eligibility: vi.fn(),
  visible: new Set<string>(),
  bodyRenders: new Map<string, number>()
}))
const pending = (): Promise<never> => new Promise(() => {})

vi.mock('./source-control/panel/panel', async (original) => {
  const { SourceControlPanel: Panel } = await original<typeof PanelModule>()
  const { useSourceControlScope } = await import('./source-control/panel/worktree-scope')
  return {
    SourceControlPanel: () => {
      const id = useSourceControlScope()?.worktreeId ?? 'selected'
      return (
        <Profiler
          id={id}
          onRender={() => probes.bodyRenders.set(id, (probes.bodyRenders.get(id) ?? 0) + 1)}
        >
          <Panel />
        </Profiler>
      )
    }
  }
})

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
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (original) => ({
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
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', async (original) => ({
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
  watchRuntimeRepoBaseRefDefault: () => () => {},
  searchRuntimeRepoBaseRefs: async () => ['feature/live']
}))

// Report a section on screen only when the test made it visible, as a scrolled sidebar would.
const observed = new Map<Element, IntersectionObserver>()
class ViewportIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
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
    settings: getDefaultSettings('/tmp'),
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
    expect(atMount.compare!.worktrees).toEqual(visible.toSorted())
    expect(atMount.compare!.calls).toBeGreaterThanOrEqual(visible.length)
    const intervals: ReturnType<typeof bodyWork>[] = []
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
  'freezes collapsed and off-screen bodies among %i sections on unrelated app writes',
  async (count) => {
    const worktrees = setup(count)
    const [active, collapsed, offScreen] = worktrees
    for (const row of worktrees) {
      probes.visible.add(row.id)
    }
    await render(<FolderWorkspaceSourceControlPanel />)
    const collapsedSection = container.querySelector(
      `[data-source-control-worktree="${collapsed!.id}"]`
    )!
    await act(async () =>
      collapsedSection.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
    )
    await scrollTo(worktrees.filter((row) => row !== offScreen).map((row) => row.id))
    const writes = [
      () =>
        useAppStore.setState((state) => ({
          worktreesByRepo: {
            repo: state.worktreesByRepo.repo!.map((row) =>
              row.id === collapsed!.id ? { ...row, lastActivityAt: 99 } : row
            )
          }
        })),
      () =>
        useAppStore.setState((state) => ({
          settings: {
            ...state.settings!,
            theme: state.settings?.theme === 'dark' ? 'light' : 'dark'
          }
        })),
      () =>
        useAppStore.setState((state) => ({
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            'folder:feature': 'other-group'
          },
          activeTabTypeByWorktree: {
            ...state.activeTabTypeByWorktree,
            'folder:feature': 'terminal'
          }
        })),
      () =>
        useAppStore.setState((state) => ({
          groupsByWorktree: {
            ...state.groupsByWorktree,
            'folder:feature': [
              { id: 'other-group', worktreeId: 'folder:feature', tabOrder: [], activeTabId: null }
            ]
          }
        })),
      () =>
        useAppStore.setState((state) => ({
          openFiles: [
            ...state.openFiles,
            {
              id: 'unrelated-file',
              worktreeId: 'elsewhere',
              filePath: '/elsewhere/other.ts',
              relativePath: 'other.ts',
              language: 'typescript',
              mode: 'edit',
              isDirty: false
            }
          ]
        })),
      () =>
        useAppStore.setState((state) => ({
          gitStatusByWorktree: {
            ...state.gitStatusByWorktree,
            elsewhere: [{ path: 'other.ts', status: 'modified', area: 'unstaged' }]
          }
        })),
      writeUnrelatedGeneration
    ]
    for (const [writeIndex, write] of writes.entries()) {
      probes.bodyRenders.clear()
      probes.eligibility.mockClear()
      await act(async () => write())
      for (const row of worktrees) {
        expect(probes.bodyRenders.get(row.id) ?? 0, `write ${writeIndex}, owner ${row.id}`).toBe(0)
      }
      expect(probes.eligibility).not.toHaveBeenCalled()
    }
    probes.bodyRenders.clear()
    await act(async () =>
      useAppStore.setState((state) => ({
        openFiles: [
          ...state.openFiles,
          {
            id: 'active-file',
            worktreeId: active!.id,
            filePath: `${active!.path}/a.ts`,
            relativePath: 'a.ts',
            language: 'typescript',
            mode: 'edit',
            isDirty: false
          }
        ],
        activeFileIdByWorktree: {
          ...state.activeFileIdByWorktree,
          'folder:feature': 'active-file'
        },
        activeTabTypeByWorktree: { ...state.activeTabTypeByWorktree, 'folder:feature': 'editor' }
      }))
    )
    expect(
      container
        .querySelector(
          `[data-source-control-worktree="${active!.id}"] [data-source-control-path="a.ts"]`
        )
        ?.getAttribute('data-current')
    ).toBe('true')
    expect(probes.bodyRenders.get(active!.id)).toBeGreaterThan(0)
    for (const row of worktrees.slice(1)) {
      expect(probes.bodyRenders.get(row.id) ?? 0).toBe(0)
    }
    // The frozen views ignore their own status and owner changes, while a relevant live update is visible.
    probes.bodyRenders.clear()
    await act(async () =>
      useAppStore.setState((state) => ({
        gitStatusByWorktree: {
          ...state.gitStatusByWorktree,
          [active!.id]: [
            ...state.gitStatusByWorktree[active!.id]!,
            { path: 'visible.ts', status: 'modified', area: 'unstaged' }
          ],
          [offScreen!.id]: [
            ...state.gitStatusByWorktree[offScreen!.id]!,
            { path: 'hidden.ts', status: 'modified', area: 'unstaged' }
          ]
        }
      }))
    )
    expect(probes.bodyRenders.get(active!.id)).toBeGreaterThan(0)
    expect(probes.bodyRenders.get(collapsed!.id) ?? 0).toBe(0)
    expect(probes.bodyRenders.get(offScreen!.id) ?? 0).toBe(0)
    expect(
      container.querySelector(`[data-source-control-worktree="${active!.id}"]`)!.textContent
    ).toContain('visible.ts')
    await scrollTo(worktrees.map((row) => row.id))
    expect(
      container.querySelector(`[data-source-control-worktree="${offScreen!.id}"]`)!.textContent
    ).toContain('hidden.ts')
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

it.each(['off-screen', 'collapsed'])(
  'keeps selection and draft while %s and resumes the current owner snapshot',
  async (inactive) => {
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

    const draft = section!.querySelector<HTMLTextAreaElement>('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(draft, 'fix: keep my draft')
      draft.dispatchEvent(new Event('input', { bubbles: true }))
      draft.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(draft.value).toBe('fix: keep my draft')
    await (inactive === 'off-screen'
      ? scrollTo([])
      : act(async () =>
          section!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
        ))
    await act(async () =>
      useAppStore.setState((state) => ({
        worktreesByRepo: {
          repo: state.worktreesByRepo.repo!.map((row) =>
            row.id === first!.id ? { ...row, branch: 'refs/heads/current-branch' } : row
          )
        },
        gitStatusByWorktree: {
          ...state.gitStatusByWorktree,
          [first!.id]: [
            ...state.gitStatusByWorktree[first!.id]!,
            { path: 'latest.ts', status: 'modified', area: 'unstaged' }
          ]
        }
      }))
    )
    expect(section!.querySelector('[data-source-control-path="latest.ts"]')).toBeNull()
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

    await (inactive === 'off-screen'
      ? scrollTo([first!.id])
      : act(async () =>
          section!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
        ))
    expect(section?.textContent).toContain('1 selected')
    expect(section!.querySelector('[data-source-control-path="latest.ts"]')).toBeTruthy()
    expect(section!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'fix: keep my draft'
    )
  }
)

it('opens a deleted section entry as its diff from Open in File Explorer', async () => {
  const [owner] = setup(1)
  useAppStore.setState({
    gitStatusByWorktree: {
      [owner!.id]: [{ path: 'deleted.ts', status: 'deleted', area: 'unstaged' }]
    }
  })
  probes.visible.add(owner!.id)
  const openDiff = vi.spyOn(useAppStore.getState(), 'openDiff').mockImplementation(() => {})
  const openFile = vi.spyOn(useAppStore.getState(), 'openFile').mockImplementation(() => 'unused')
  await render(<FolderWorkspaceSourceControlPanel />)
  const row = container.querySelector('[data-testid="source-control-entry"]')!
  await act(async () =>
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
  )
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
    node.textContent?.includes('Open in File Explorer')
  )
  expect(item).toBeTruthy()
  await act(async () => item!.click())
  expect(openDiff).toHaveBeenCalledWith(
    owner!.id,
    '/child-0/deleted.ts',
    'deleted.ts',
    'typescript',
    false,
    expect.objectContaining({ placementWorkspaceId: 'folder:feature' })
  )
  expect(openFile).not.toHaveBeenCalled()
})

it('split-opens child content in the current placement group after a focus change', async () => {
  const [owner] = setup(1)
  probes.visible.add(owner!.id)
  const createSplit = vi.fn(() => 'new-split')
  const openDiff = vi.fn()
  useAppStore.setState({ createEmptySplitGroup: createSplit, openDiff })
  await render(<FolderWorkspaceSourceControlPanel />)
  await act(async () =>
    useAppStore.setState({
      activeGroupIdByWorktree: { 'folder:feature': 'current-group' },
      groupsByWorktree: {
        'folder:feature': [
          { id: 'current-group', worktreeId: 'folder:feature', tabOrder: [], activeTabId: null }
        ]
      }
    })
  )
  const row = container.querySelector('[data-testid="source-control-entry"]')!
  await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
  expect(createSplit).toHaveBeenCalledWith('folder:feature', 'current-group', 'right')
  expect(openDiff).toHaveBeenCalledWith(
    owner!.id,
    '/child-0/a.ts',
    'a.ts',
    'typescript',
    false,
    expect.objectContaining({
      placementWorkspaceId: 'folder:feature',
      targetGroupId: 'new-split',
      preview: false
    })
  )
})

it('keeps an owned base-ref dialog usable after its section leaves the viewport and collapses', async () => {
  const worktrees = setup(3)
  probes.visible.add(worktrees[0]!.id)
  await render(<FolderWorkspaceSourceControlPanel />)
  const changeBase = screen.getByRole('button', { name: /Change base ref/ })
  await act(async () => fireEvent.click(changeBase))
  await scrollTo([])
  const section = container.querySelector('section')!
  const collapse = section.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!
  await act(async () => fireEvent.click(collapse))
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText('Search branches by name...'), {
      target: { value: 'feature' }
    })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(screen.getByRole('button', { name: 'feature/live' })).toBeTruthy()
})
