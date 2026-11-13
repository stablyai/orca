// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { type ReactNode, type Ref, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupBrowseState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-browse-state'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { resetWorkspaceCleanupBrowsePersistTimer } from '../../../store/slices/workspace-cleanup/workspace-cleanup-browse'
import {
  NOW,
  makeCandidate
} from '../../../store/slices/workspace-cleanup/workspace-cleanup-slice-test-harness'
import WorkspaceCleanupDialog from '../WorkspaceCleanupDialog'

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

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
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
      clearDismissals: vi.fn().mockResolvedValue(undefined)
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

describe('WorkspaceCleanupDialog stale-while-revalidate', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Fake Date only: labels need a fixed clock but flush uses real timers.
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
    // Settle module-global scan dedupe between cases so later tests cannot join a prior unresolved scan.
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

  it('keeps selections across a refresh and surfaces vanished selections', async () => {
    const rig = installApi(cachedFleet())
    await renderDialog()
    await openDialog()
    await act(async () => {
      rig.resolvers.at(-1)?.(cachedFleet())
    })
    await flush()

    expect(rowCheckbox('alpha')?.getAttribute('aria-checked')).toBe('false')
    expect(rowCheckbox('beta')?.getAttribute('aria-checked')).toBe('false')

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
})
