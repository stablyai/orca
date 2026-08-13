// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from '../../../../shared/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'worktree-visibility' as string | null,
    modalData: { repoId: 'repo-1' } as Record<string, unknown>,
    closeModal: vi.fn(),
    repos: [] as unknown[],
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn(),
    detectedWorktreesByRepo: {} as Record<string, unknown>
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
    // Why: the inbox already stopped announcing this path; recovery must not depend on it.
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
  mocks.state.updateRepo.mockResolvedValue(true)
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => (candidate.textContent ?? '').trim() === text
  )
  if (!button) {
    throw new Error(`No button with text "${text}"`)
  }
  return button as HTMLButtonElement
}

function alwaysShowSwitch(): HTMLButtonElement {
  const control = document.querySelector('[role="switch"]')
  if (!control) {
    throw new Error('No Always show switch')
  }
  return control as HTMLButtonElement
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('WorktreeVisibilityDialog', () => {
  it('lists a hidden agent worktree with a repo-relative path', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (1)')
    expect(document.body.textContent).toContain(
      'Choose which hidden worktrees to show individually.'
    )
    expect(document.body.textContent).toContain('scratch-1')
    expect(document.body.textContent).toContain('.claude/worktrees/scratch-1')
    expect(document.body.textContent).not.toContain('/repo/.claude')
    expect(
      document.querySelector('button[aria-label="Which worktrees are hidden by default?"]')
    ).not.toBeNull()
  })

  it('bounds rendered rows for repositories with many hidden worktrees', async () => {
    const worktrees = Array.from({ length: 500 }, (_, index) =>
      makeWorktree({
        id: `hidden-${index}`,
        path: `/repo/.claude/worktrees/scratch-${index}`,
        displayName: `scratch-${index}`
      })
    )
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected(worktrees) }

    await renderDialog()

    expect(document.body.textContent).toContain('Hidden worktrees (500)')
    expect(document.querySelectorAll('ul > li').length).toBeLessThan(20)
  })

  it('recovers a hidden worktree per path through the existing import exception', async () => {
    // Why: individual recovery remains available while the repo-wide policy is off.
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      importedExternalWorktreePaths: [SCRATCH_PATH],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
    })
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('omits the hidden list when nothing is recoverable', async () => {
    mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected([]) }
    await renderDialog()

    expect(document.body.textContent).not.toContain('Hidden worktrees')
  })

  it('says it is checking instead of claiming nothing is hidden on a fallback snapshot', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(document.body.textContent).toContain('Checking…')
    expect(document.body.textContent).not.toContain('Hidden worktrees')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
  })

  it('offers a retry instead of a dead end when the list cannot be read', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )

    // Why: a successful authoritative refetch also writes the trusted snapshot.
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.detectedWorktreesByRepo = { 'repo-1': makeDetected() }
      return true
    })
    await click(buttonWithText('Try again'))

    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Hidden worktrees')
  })

  it('keeps rows visible but not actionable until the open-time scan settles', async () => {
    // Why: a Show clicked mid-scan could join the pre-write refetch and read
    // success off a list computed before the import landed — a silent no-op.
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(document.body.textContent).toContain('scratch-1')
    expect(buttonWithText('Show').disabled).toBe(true)
    expect(document.body.textContent).toContain('Checking…')
  })

  it('locks the repo-wide toggle until the open-time scan settles', async () => {
    // Why: its post-write refresh must not coalesce onto a list started before the visibility write.
    mocks.state.fetchWorktrees.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    expect(alwaysShowSwitch().disabled).toBe(true)
  })

  it('reports a failed refresh even while an older trusted snapshot is on screen', async () => {
    // Why: a warm snapshot must not present stale rows as current with no
    // failure indication when the host has since become unreachable.
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    expect(document.body.textContent).toContain('scratch-1')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )
  })

  it('locks retry while a row import is in flight, so it cannot race the write', async () => {
    // Why: a retry scan started before the import's write lands can absorb the
    // import's own refetch and report success off a pre-import list.
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(buttonWithText('Try again').disabled).toBe(true)
  })

  it('locks the repo-wide toggle while a row import is in flight', async () => {
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(buttonWithText('Show'))

    expect(alwaysShowSwitch().disabled).toBe(true)
  })

  it('locks row actions and retry while the repo-wide toggle is in flight', async () => {
    mocks.state.fetchWorktrees.mockResolvedValueOnce(false)
    mocks.state.updateRepo.mockImplementation(() => new Promise(() => {}))
    await renderDialog()

    await click(alwaysShowSwitch())

    expect(buttonWithText('Show').disabled).toBe(true)
    expect(buttonWithText('Try again').disabled).toBe(true)
  })

  it('clears a stale failure once a row import refreshes the list successfully', async () => {
    mocks.state.fetchWorktrees.mockResolvedValueOnce(false)
    await renderDialog()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()

    mocks.state.fetchWorktrees.mockResolvedValue(true)
    await click(buttonWithText('Show'))

    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not leak an old repo action failure into a newly opened repo', async () => {
    const update = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(update.promise)
    await renderDialog()
    await click(buttonWithText('Show'))

    mocks.state.modalData = { repoId: 'repo-2' }
    mocks.state.repos = [makeRepo({ id: 'repo-2', path: '/repo-2', displayName: 'other' })]
    mocks.state.detectedWorktreesByRepo = { 'repo-2': makeDetected([], { repoId: 'repo-2' }) }
    await renderDialog()

    update.resolve(false)
    await act(async () => update.promise)

    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

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
    await click(alwaysShowSwitch())

    await act(async () => root.render(null))
    await renderDialog()

    expect(alwaysShowSwitch().disabled).toBe(true)
    expect(buttonWithText('Show').disabled).toBe(true)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()

    await act(async () => {
      update.resolve(false)
      await update.promise
      await Promise.resolve()
    })
    expect(alwaysShowSwitch().disabled).toBe(false)
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

  it('reports a failed persistent visibility update without starting a refresh', async () => {
    mocks.state.updateRepo.mockResolvedValue(false)
    await renderDialog()
    mocks.state.fetchWorktrees.mockClear()

    await click(alwaysShowSwitch())

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not update worktree visibility. Try again.'
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('reports a failed authoritative refresh after updating persistent visibility', async () => {
    await renderDialog()
    mocks.state.fetchWorktrees.mockResolvedValue(false)

    await click(alwaysShowSwitch())

    expect(mocks.state.fetchWorktrees).toHaveBeenLastCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )
  })

  it('enables the persistent policy for regular and agent worktrees', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('Always show')
    expect(document.body.textContent).toContain('1 worktree currently hidden')
    expect(alwaysShowSwitch().getAttribute('aria-checked')).toBe('false')

    await click(alwaysShowSwitch())

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show',
      agentWorktreeVisibility: 'show',
      externalWorktreeDiscoverySuppressedAt: null
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('keeps the combined switch off until the agent policy is explicitly enabled', async () => {
    mocks.state.repos = [makeRepo({ externalWorktreeVisibility: 'show' })]
    await renderDialog()

    expect(alwaysShowSwitch().getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('scratch-1')

    await click(alwaysShowSwitch())

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show',
      agentWorktreeVisibility: 'show',
      externalWorktreeDiscoverySuppressedAt: null
    })
  })

  it('turns the persistent policy off without closing the dialog', async () => {
    mocks.state.repos = [
      makeRepo({ externalWorktreeVisibility: 'show', agentWorktreeVisibility: 'show' })
    ]
    await renderDialog()

    expect(document.body.textContent).toContain('0 worktrees currently shown')
    expect(alwaysShowSwitch().getAttribute('aria-checked')).toBe('true')

    await click(alwaysShowSwitch())

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'hide',
      agentWorktreeVisibility: 'hide'
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })
})
