import type {
  DetectedWorktreeListResult,
  DetectedWorktree
} from '../../../../shared/worktree/types'

import { type ReactNode, act } from 'react'
import { type Root, createRoot } from 'react-dom/client'

import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'worktree-visibility' as string | null,
    modalData: { repoId: 'repo-1' } as Record<string, unknown>,
    closeModal: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    repos: [] as unknown[],
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn(),
    detectedWorktreesByRepo: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    worktreeVisibilityDefaultsByHost: {} as Record<string, unknown>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''))
      : fallback
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 56,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({
        index,
        key: index,
        start: index * 56,
        size: 56,
        end: (index + 1) * 56,
        lane: 0
      })),
    measureElement: vi.fn()
  })
}))

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: Date.UTC(2026, 4, 24),
    externalWorktreeVisibility: 'hide',
    externalWorktreeVisibilityPromptDismissedAt: 1,
    // Recovery must work after the inbox has stopped announcing this path.
    externalWorktreeInboxBaselinePaths: [SCRATCH_PATH],
    ...overrides
  }
}

export function makeWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: `repo-1::${overrides.path ?? SCRATCH_PATH}`,
    repoId: 'repo-1',
    path: SCRATCH_PATH,
    displayName: 'scratch-1',
    branch: 'refs/heads/scratch-1',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: false,
    ...overrides
  } as DetectedWorktree
}

export function makeDetected(
  worktrees: DetectedWorktree[] = [makeWorktree()],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees,
    ...overrides
  }
}

export let container: HTMLDivElement
export let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activeModal = 'worktree-visibility'
  mocks.state.modalData = { repoId: 'repo-1' }
  mocks.state.repos = [makeRepo()]
  mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected() }
  mocks.state.settings = {}
  mocks.state.worktreeVisibilityDefaultsByHost = {}
  mocks.state.updateRepo.mockImplementation(
    async (repoId: string, updates: Record<string, unknown>) => {
      const repo = (mocks.state.repos as Repo[]).find((candidate) => candidate.id === repoId)
      if (!repo) {
        return false
      }
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          delete (repo as unknown as Record<string, unknown>)[key]
        } else {
          ;(repo as unknown as Record<string, unknown>)[key] = value
        }
      }
      return true
    }
  )
  mocks.state.fetchWorktrees.mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
  vi.resetModules()
})

export async function renderDialog(): Promise<void> {
  const { default: WorktreeVisibilityDialog } = await import('./WorktreeVisibilityDialog')
  await act(async () => {
    root.render(<WorktreeVisibilityDialog />)
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function buttonWithText(text: string): HTMLButtonElement {
  // Recovery buttons share labels with source segments; exclude source controls.
  const button = [...document.querySelectorAll('button:not([data-visibility])')].find(
    (candidate) => (candidate.textContent ?? '').trim() === text
  )
  if (!button) {
    throw new Error(`No button with text "${text}"`)
  }
  return button as HTMLButtonElement
}

export function sourceSegment(label: string, visibility: 'show' | 'hide'): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(
    `[aria-label="Visibility for ${label}"] [data-visibility="${visibility}"]`
  )
  if (!control) {
    throw new Error(`No ${visibility} segment for ${label}`)
  }
  return control
}

export const sourceSwitch = (label = 'Claude Code'): HTMLButtonElement =>
  sourceSegment(label, 'show')

export function sourceRow(label: string): HTMLElement {
  const row = sourceSwitch(label).closest<HTMLElement>('[data-source-row]')
  if (!row) {
    throw new Error(`No ${label} source row`)
  }
  return row
}

export function inheritEverythingFromGlobal(): void {
  mocks.state.repos = [makeRepo({ externalWorktreeVisibility: undefined })]
  mocks.state.settings = {
    worktreeVisibilityDefaults: {
      external: 'hide',
      sourcePreferences: { builtIn: { claude: 'show' } }
    }
  }
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

export async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export async function setGroupedRecovery(repos: Repo[], source: Repo) {
  const { projectHostSetupProjectionFromRepos } =
    await import('../../../../shared/project-host-setup-projection')
  const { buildProjectGroups } = await import('../../../../shared/project-grouping')
  const projection = projectHostSetupProjectionFromRepos(repos)
  const groups = buildProjectGroups({
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  expect(groups).toHaveLength(1)
  const recoveryTargets = groups[0].registrations.map((setup) => ({
    repoId: setup.repoId,
    hostId: setup.hostId
  }))
  mocks.state.repos = repos
  mocks.state.modalData = {
    repoId: source.id,
    hostId: source.executionHostId ?? 'local',
    recoveryTargets
  }
  return recoveryTargets
}

export { mocks }
