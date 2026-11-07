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
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

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
