// @vitest-environment happy-dom
import type { ReactNode, Ref } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import { createTestStore, seedStore } from '../../store/slices/store-test-helpers'
import { resetWorkspaceCleanupBrowsePersistTimer } from '../../store/slices/workspace-cleanup-browse'
import { NOW, makeCandidate } from '../../store/slices/workspace-cleanup-slice-test-harness'
import WorkspaceCleanupDialog from './WorkspaceCleanupDialog'

const holders = vi.hoisted(() => ({
  store: null as unknown as { (selector: (s: unknown) => unknown): unknown } & {
    getState: () => Record<string, unknown>
    setState: (partial: unknown) => void
    subscribe: (listener: (state: unknown, previous: unknown) => void) => () => void
  },
  infoToasts: [] as string[],
  activateAndRevealWorktree: vi.fn(),
  rig: null as null | {
    resolvers: ((result: WorkspaceCleanupScanResult) => void)[]
  }
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (s: unknown) => unknown): unknown => holders.store(selector)
  useAppStore.getState = () => holders.store.getState()
  useAppStore.setState = (partial: unknown) => holders.store.setState(partial)
  useAppStore.subscribe = (listener: (state: unknown, previous: unknown) => void) =>
    holders.store.subscribe(listener)
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: (message: unknown) => holders.infoToasts.push(String(message))
  })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: holders.activateAndRevealWorktree
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, viewportRef }: { children: ReactNode; viewportRef?: Ref<unknown> }) => (
    <div ref={viewportRef as Ref<HTMLDivElement>}>{children}</div>
  ),
  ScrollBar: () => null
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const CACHED_AT = NOW - 2 * 60 * 60 * 1000

type ScanRig = {
  scan: ReturnType<typeof vi.fn>
  progressCallbacks: ((progress: WorkspaceCleanupScanProgress) => void)[]
  resolvers: ((result: WorkspaceCleanupScanResult) => void)[]
}

function installApi(cachedScan: WorkspaceCleanupScanResult | null): ScanRig {
  const rig: ScanRig = { scan: vi.fn(), progressCallbacks: [], resolvers: [] }
  rig.scan.mockImplementation(
    (
      args?: { worktreeId?: string },
      onProgress?: (progress: WorkspaceCleanupScanProgress) => void
    ) => {
      if (args?.worktreeId) {
        return Promise.resolve({
          scannedAt: NOW,
          candidates: [makeCandidate({ worktreeId: args.worktreeId })],
          errors: []
        })
      }
      if (onProgress) {
        rig.progressCallbacks.push(onProgress)
      }
      return new Promise<WorkspaceCleanupScanResult>((resolve) => {
        rig.resolvers.push(resolve)
      })
    }
  )
  ;(window as unknown as { api: unknown }).api = {
    workspaceCleanup: {
      scan: rig.scan,
      getCachedScan: vi.fn().mockResolvedValue(cachedScan),
      dismiss: vi.fn().mockResolvedValue(undefined),
      clearDismissals: vi.fn().mockResolvedValue(undefined),
      hasKillableLocalProcesses: vi.fn().mockResolvedValue({ hasKillableProcesses: false })
    },
    workspaceSpace: {
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
      analyze: vi.fn(),
      cancel: vi.fn().mockResolvedValue(false),
      onProgress: vi.fn().mockReturnValue(() => undefined)
    },
    ui: { set: vi.fn().mockResolvedValue(undefined) }
  }
  holders.rig = rig
  return rig
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderDialog(): Promise<void> {
  await act(async () => {
    root?.render(<WorkspaceCleanupDialog />)
  })
}

async function openDialog(): Promise<void> {
  await act(async () => {
    holders.store.setState({ activeModal: 'workspace-cleanup' })
  })
  await flush()
}

function rowNames(): string[] {
  return [...(container?.querySelectorAll('[data-workspace-cleanup-row-name]') ?? [])].map(
    (node) => node.textContent ?? ''
  )
}

function rowCheckbox(name: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[aria-label^="Select ${name} on "]`) ?? null
}

function cachedFleet(): WorkspaceCleanupScanResult {
  return {
    scannedAt: CACHED_AT,
    candidates: [
      makeCandidate({ worktreeId: 'repo1::/tmp/alpha', displayName: 'alpha' }),
      makeCandidate({ worktreeId: 'repo1::/tmp/beta', displayName: 'beta' })
    ],
    errors: []
  }
}

function progressTick(
  rig: ScanRig,
  progress: Partial<WorkspaceCleanupScanProgress> & Pick<WorkspaceCleanupScanProgress, 'candidates'>
): void {
  rig.progressCallbacks.at(-1)?.({
    scanId: 'scan-1',
    scannedAt: NOW,
    scannedWorktreeCount: progress.candidates.length,
    totalWorktreeCount: 3,
    errors: [],
    candidateMode: 'append',
    ...progress
  })
}

describe('WorkspaceCleanupDialog stale-while-revalidate', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Why Date-only fake: relative "Updated Xh ago" labels need a pinned clock,
    // but flush() depends on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const store = createTestStore()
    seedStore(store, {})
    holders.store = store as unknown as typeof holders.store
    holders.infoToasts = []
    holders.activateAndRevealWorktree.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      act(() => root?.unmount())
    }
    // Why: broad-scan dedupe lives in slice module state; an unresolved scan
    // left by one case would silently join into the next case's scan call.
    for (const resolve of holders.rig?.resolvers ?? []) {
      resolve({ scannedAt: NOW, candidates: [], errors: [] })
    }
    holders.rig = null
    await new Promise((resolve) => setTimeout(resolve, 0))
    container?.remove()
    root = null
    container = null
    resetWorkspaceCleanupBrowsePersistTimer()
    vi.useRealTimers()
  })

  it('renders the cached snapshot immediately and kicks one background rescan', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()

    // Full list from cache while the rescan is still streaming (unresolved).
    expect(rowNames()).toEqual(expect.arrayContaining(['alpha', 'beta']))
    expect(rig.scan).toHaveBeenCalledTimes(1)
    expect(container?.textContent).toContain('Updated 2h ago')
    expect(container?.textContent).toContain('Refreshing')
  })

  it('opens a cleanup row on the host that produced it', async () => {
    installApi({
      scannedAt: CACHED_AT,
      candidates: [
        makeCandidate({
          worktreeId: 'repo1::/tmp/remote',
          displayName: 'remote',
          executionHostId: 'ssh:box'
        })
      ],
      errors: []
    })
    await renderDialog()
    await openDialog()

    await act(async () => {
      container?.querySelector<HTMLElement>('[aria-label^="Open remote"]')?.click()
    })

    expect(holders.activateAndRevealWorktree).toHaveBeenCalledWith('repo1::/tmp/remote', {
      executionHostId: 'ssh:box'
    })
  })

  it('reconciles streamed rows into the cached list without clearing it', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()

    progressTick(rig, {
      candidates: [
        makeCandidate({
          worktreeId: 'repo1::/tmp/alpha',
          displayName: 'alpha',
          fingerprint: 'fingerprint-alpha-2'
        }),
        makeCandidate({ worktreeId: 'repo1::/tmp/gamma', displayName: 'gamma' })
      ],
      scannedWorktreeCount: 2
    })
    await flush()

    // beta was not re-reported yet; it must still be on screen mid-refresh.
    expect(rowNames()).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']))
  })

  it('keeps search and selection interactive while rows stream in', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()

    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search workspaces"]')
    expect(search?.disabled).toBe(false)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(search, 'beta')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    progressTick(rig, {
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/gamma', displayName: 'gamma' })],
      scannedWorktreeCount: 1
    })
    await flush()

    // Filter applied mid-stream: only beta visible even as new rows arrive.
    expect(rowNames()).toEqual(['beta'])

    await act(async () => {
      setter?.call(search, '')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(rowNames()).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']))

    // Rows stay selectable during the stream.
    const checkbox = rowCheckbox('alpha')
    expect(checkbox).not.toBeNull()
    const before = checkbox?.getAttribute('aria-checked')
    await act(async () => {
      checkbox?.click()
    })
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).not.toBe(before)
  })

  it('does not clear selection while free-text search hides the row', async () => {
    installApi(cachedFleet())
    await renderDialog()
    await openDialog()

    if (rowCheckbox('alpha')?.getAttribute('aria-checked') !== 'true') {
      await act(async () => rowCheckbox('alpha')?.click())
    }
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('true')
    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search workspaces"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(search, 'beta')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(rowNames()).toEqual(['beta'])

    await act(async () => {
      setter?.call(search, '')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('true')
  })

  it('reports selections removed by facet filters', async () => {
    installApi({
      scannedAt: CACHED_AT,
      candidates: [
        makeCandidate({
          worktreeId: 'repo1::/tmp/alpha',
          displayName: 'alpha',
          blockers: ['pinned']
        }),
        makeCandidate({ worktreeId: 'repo1::/tmp/beta', displayName: 'beta' })
      ],
      errors: []
    })
    await renderDialog()
    await openDialog()

    await act(async () => rowCheckbox('alpha')?.click())
    const browse = holders.store.getState().workspaceCleanupBrowse as WorkspaceCleanupBrowseState
    await act(async () => {
      holders.store.setState({
        workspaceCleanupBrowse: {
          ...browse,
          filters: {
            ...browse.filters,
            safety: {
              ...browse.filters.safety,
              blockers: ['pinned'],
              blockerMode: 'none-of'
            }
          }
        }
      })
    })
    await flush()

    expect(holders.infoToasts).toContain(
      '1 selected workspace is hidden by the current filters and was deselected.'
    )

    await act(async () => holders.store.setState({ workspaceCleanupBrowse: browse }))
    await flush()
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('false')
  })

  it('adopts the in-flight scan on reopen instead of starting a duplicate', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()
    expect(rig.scan).toHaveBeenCalledTimes(1)

    progressTick(rig, {
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/gamma', displayName: 'gamma' })],
      scannedWorktreeCount: 1
    })
    await flush()

    // Close at 40% and reopen: the same scan keeps streaming into the store.
    await act(async () => {
      holders.store.setState({ activeModal: null })
    })
    await openDialog()
    expect(rig.scan).toHaveBeenCalledTimes(1)

    progressTick(rig, {
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/delta', displayName: 'delta' })],
      scannedWorktreeCount: 2
    })
    await flush()
    await act(async () => {
      rig.resolvers.at(-1)?.({
        scannedAt: NOW,
        candidates: [
          ...cachedFleet().candidates,
          makeCandidate({ worktreeId: 'repo1::/tmp/gamma', displayName: 'gamma' }),
          makeCandidate({ worktreeId: 'repo1::/tmp/delta', displayName: 'delta' })
        ],
        errors: []
      })
    })
    await flush()

    expect(rig.scan).toHaveBeenCalledTimes(1)
    expect(rowNames()).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma', 'delta']))
  })

  it('keeps selections across a refresh and surfaces vanished selections', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()
    await act(async () => {
      rig.resolvers.at(-1)?.(cachedFleet())
    })
    await flush()

    // Nothing is pre-selected: the dialog no longer acts on its own verdict.
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('false')
    expect(rowCheckbox('beta')?.getAttribute('aria-checked')).toBe('false')

    // The user selects both, which is what must survive the refresh.
    await act(async () => {
      rowCheckbox('alpha')?.click()
      rowCheckbox('beta')?.click()
    })
    await flush()
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('true')
    expect(rowCheckbox('beta')?.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      container?.querySelector<HTMLElement>('[aria-label="Refresh"]')?.click()
    })
    await flush()
    expect(rig.scan).toHaveBeenCalledTimes(2)
    // Selection survives while the refresh streams.
    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      rig.resolvers.at(-1)?.({
        scannedAt: NOW + 1,
        candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/alpha', displayName: 'alpha' })],
        errors: []
      })
    })
    await flush()

    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('true')
    expect(rowNames()).not.toContain('beta')
    expect(holders.infoToasts).toContain('1 selected workspace no longer exists.')
  })

  it('keeps selected active workspaces outside the select-all scope', async () => {
    installApi({
      scannedAt: CACHED_AT,
      candidates: [
        makeCandidate({ worktreeId: 'repo1::/tmp/ready', displayName: 'ready' }),
        makeCandidate({
          worktreeId: 'repo1::/tmp/active',
          displayName: 'active',
          reasons: [],
          blockers: ['active-workspace']
        })
      ],
      errors: []
    })
    await renderDialog()
    await openDialog()

    await act(async () => rowCheckbox('active')?.click())
    const selectAll = container?.querySelector<HTMLElement>(
      '[aria-label="Select 1 safety-checked workspace"]'
    )
    expect(selectAll?.getAttribute('aria-checked')).toBe('false')

    await act(async () => selectAll?.click())
    expect(rowCheckbox('ready')?.getAttribute('aria-checked')).toBe('true')
    expect(rowCheckbox('active')?.getAttribute('aria-checked')).toBe('true')

    await act(async () => selectAll?.click())
    expect(rowCheckbox('ready')?.getAttribute('aria-checked')).toBe('false')
    expect(rowCheckbox('active')?.getAttribute('aria-checked')).toBe('true')
  })
})
