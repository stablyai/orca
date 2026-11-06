// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult
} from '../../../../../../shared/worktree/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'

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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
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

function makeWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
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

function makeDetected(
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

let container: HTMLDivElement
let root: Root

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

async function renderDialog(): Promise<void> {
  const { default: WorktreeVisibilityDialog } = await import('./WorktreeVisibilityDialog')
  await act(async () => {
    root.render(<WorktreeVisibilityDialog />)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function buttonWithText(text: string): HTMLButtonElement {
  // Recovery buttons share labels with source segments; exclude source controls.
  const button = [...document.querySelectorAll('button:not([data-visibility])')].find(
    (candidate) => (candidate.textContent ?? '').trim() === text
  )
  if (!button) {
    throw new Error(`No button with text "${text}"`)
  }
  return button as HTMLButtonElement
}

function sourceSegment(label: string, visibility: 'show' | 'hide'): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(
    `[aria-label="Visibility for ${label}"] [data-visibility="${visibility}"]`
  )
  if (!control) {
    throw new Error(`No ${visibility} segment for ${label}`)
  }
  return control
}

const sourceSwitch = (label = 'Claude Code'): HTMLButtonElement => sourceSegment(label, 'show')

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('WorktreeVisibilityDialog', () => {
  it('keeps a remounted repo locked until its earlier row action settles', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()
    await click(buttonWithText('Show'))

    await act(async () => root.render(null))
    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (1)')
    expect(buttonWithText('Showing…').disabled).toBe(true)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()

    await act(async () => {
      update.resolve(false)
      await update.promise
      await Promise.resolve()
    })
    expect(buttonWithText('Show').disabled).toBe(false)
  })

  it('keeps a remounted repo locked until its earlier toggle settles', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()
    await click(sourceSwitch())

    await act(async () => root.render(null))
    await renderDialog()

    expect(sourceSwitch().disabled).toBe(true)
    expect(buttonWithText('Show').disabled).toBe(true)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()

    await act(async () => {
      update.resolve(false)
      await update.promise
      await Promise.resolve()
    })
    expect(sourceSwitch().disabled).toBe(false)
  })

  it('does not carry a mutation fence across same-id repos on different hosts', async () => {
    const update = deferred<boolean>()
    const localWorktree = makeWorktree({ hostId: 'local' })
    const remotePath = '/srv/repo/.claude/worktrees/remote-scratch'
    const remoteWorktree = makeWorktree({
      id: `repo-1::${remotePath}`,
      path: remotePath,
      displayName: 'remote-scratch',
      hostId: 'runtime:env-1'
    })
    mocks.state.modalData = { repoId: 'repo-1', hostId: 'local' }
    mocks.state.repos = [
      makeRepo(),
      makeRepo({ path: '/srv/repo', displayName: 'remote', executionHostId: 'runtime:env-1' })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([localWorktree, remoteWorktree])
    }
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    await click(buttonWithText('Show'))

    await act(async () => root.render(null))
    mocks.state.modalData = { repoId: 'repo-1', hostId: 'runtime:env-1' }
    mocks.state.fetchWorktrees.mockClear()
    await renderDialog()

    expect(document.body.textContent).toContain('remote-scratch')
    expect(document.body.textContent).not.toContain('scratch-1')
    expect(buttonWithText('Show').disabled).toBe(false)
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'runtime:env-1'
    })

    await click(buttonWithText('Show'))
    expect(mocks.state.updateRepo).toHaveBeenLastCalledWith(
      'repo-1',
      {
        importedExternalWorktreePaths: [remotePath],
        externalWorktreeInboxBaselinePaths: [SCRATCH_PATH, remotePath]
      },
      { hostId: 'runtime:env-1' }
    )

    await act(async () => {
      update.resolve(false)
      await update.promise
    })
  })

  it('does not report success when an older host strips additive source settings (STA-4092)', async () => {
    mocks.state.updateRepo.mockResolvedValue(true)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(sourceSwitch())

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This host doesn't support source-specific worktree visibility. Update Orca on the host to change this setting."
    )
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('Try again')
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('rejects removal success when an older host leaves the custom preference behind', async () => {
    const repo = makeRepo({
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      worktreeVisibilitySourcePreferences: { custom: { team: 'show' } }
    })
    mocks.state.repos = [repo]
    mocks.state.updateRepo.mockImplementation(async () => {
      repo.customWorktreeVisibilitySources = []
      return true
    })
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(document.querySelector('button[aria-label="Remove /srv/team-worktrees"]')!)

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not update worktree visibility. Try again.'
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })
})
