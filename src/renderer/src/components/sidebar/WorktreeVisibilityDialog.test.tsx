// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from '../../../../shared/types'

const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'
const SECOND_SCRATCH_PATH = '/repo/.claude/worktrees/scratch-2'
const EXTERNAL_PATH = '/elsewhere/manual'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'worktree-visibility' as string | null,
    modalData: { repoId: 'repo-1' } as Record<string, unknown>,
    closeModal: vi.fn(),
    repos: [] as unknown[],
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn(),
    detectedWorktreesByRepo: {} as Record<string, unknown>,
    nonOrcaWorktreeGuideDismissed: true,
    dismissNonOrcaWorktreeGuide: vi.fn(),
    persistedUIReady: true
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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: Date.UTC(2026, 4, 24),
    externalWorktreeVisibility: 'hide',
    externalWorktreeVisibilityPromptDismissedAt: 1,
    // Why: the inbox already stopped notifying about this path; recovery must not depend on it.
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
  mocks.state.nonOrcaWorktreeGuideDismissed = true
  mocks.state.persistedUIReady = true
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
})

async function renderDialog(): Promise<void> {
  const { default: WorktreeVisibilityDialog } = await import('./WorktreeVisibilityDialog')
  await act(async () => {
    root.render(<WorktreeVisibilityDialog />)
  })
}

function sectionByTitle(title: string): HTMLElement {
  const section = [...document.querySelectorAll('section')].find(
    (candidate) => candidate.querySelector('h3')?.textContent === title
  )
  if (!section) {
    throw new Error(`No section titled "${title}"`)
  }
  return section as HTMLElement
}

function buttonIn(scope: ParentNode, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').startsWith(text)
  )
  if (!button) {
    throw new Error(`No button starting with "${text}"`)
  }
  return button as HTMLButtonElement
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) {
    throw new Error(`No button labelled "${label}"`)
  }
  return button
}

function sectionTitles(): string[] {
  return [...document.querySelectorAll('h3')].map((element) => element.textContent ?? '')
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

async function expandIndividualWorktrees(sectionTitle: string): Promise<void> {
  await click(buttonIn(sectionByTitle(sectionTitle), 'Manage individually'))
}

describe('WorktreeVisibilityDialog', () => {
  it('gives both kinds the same shape: a bulk switch plus a per-worktree list', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree(),
        makeWorktree({ path: EXTERNAL_PATH, displayName: 'manual', ownership: 'external' })
      ])
    }
    await renderDialog()

    expect(sectionTitles()).toEqual(['Agent scratch worktrees', 'Other worktrees'])
    for (const title of ['Agent scratch worktrees', 'Other worktrees']) {
      const section = sectionByTitle(title)
      expect(buttonIn(section, 'Show all')).toBeTruthy()
      expect(buttonIn(section, 'Manage individually')).toBeTruthy()
    }
  })

  it('keeps per-worktree rows behind the disclosure', async () => {
    await renderDialog()

    expect(document.body.textContent).not.toContain('.claude/worktrees/scratch-1')

    await expandIndividualWorktrees('Agent scratch worktrees')

    // Why: paths inside the checkout render repo-relative so long absolute paths stay readable.
    expect(document.body.textContent).toContain('.claude/worktrees/scratch-1')
    expect(document.body.textContent).not.toContain(SCRATCH_PATH)
  })

  it('does not report a zero count for a kind this repo has none of', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('None in this repo.')
    expect(document.body.textContent).not.toContain('0 worktrees hidden together')
  })

  it('recovers a baselined agent scratch worktree through the inbox import path', async () => {
    await renderDialog()
    await expandIndividualWorktrees('Agent scratch worktrees')

    await click(buttonByLabel('Show scratch-1 in the sidebar'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      importedExternalWorktreePaths: [SCRATCH_PATH],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
    })
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('hides a visible agent scratch worktree without re-arming the inbox notification', async () => {
    mocks.state.repos = [makeRepo({ importedExternalWorktreePaths: [SCRATCH_PATH] })]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree({ visible: true })])
    }
    await renderDialog()
    await expandIndividualWorktrees('Agent scratch worktrees')

    await click(buttonByLabel('Hide scratch-1 from the sidebar'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      importedExternalWorktreePaths: []
    })
    expect(mocks.state.updateRepo.mock.calls[0][1]).not.toHaveProperty(
      'externalWorktreeInboxBaselinePaths'
    )
  })

  it('turns the agent switch into a repo policy that also covers later worktrees', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree(),
        makeWorktree({ path: SECOND_SCRATCH_PATH, displayName: 'scratch-2' })
      ])
    }
    await renderDialog()

    const section = sectionByTitle('Agent scratch worktrees')
    expect(section.textContent).toContain('2 worktrees hidden together')

    await click(buttonIn(section, 'Show all'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: 'show'
    })
    expect(mocks.state.updateRepo.mock.calls[0][1]).not.toHaveProperty(
      'importedExternalWorktreePaths'
    )
  })

  it('drops scratch imports when hiding all agent worktrees so the result is true', async () => {
    mocks.state.repos = [
      makeRepo({
        agentWorktreeVisibility: 'show',
        importedExternalWorktreePaths: [SCRATCH_PATH, '/elsewhere/manual']
      })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree({ visible: true })])
    }
    await renderDialog()

    const section = sectionByTitle('Agent scratch worktrees')
    expect(section.textContent).toContain('1 worktree shown together')
    // Why: nothing to manage row by row while the policy shows every scratch worktree.
    expect(() => buttonIn(section, 'Manage individually')).toThrow()

    await click(buttonIn(section, 'Hide all'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: ['/elsewhere/manual'],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
    })
  })

  it('reports a mixed agent state instead of claiming everything is shown', async () => {
    mocks.state.repos = [makeRepo({ importedExternalWorktreePaths: [SCRATCH_PATH] })]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree({ visible: true }),
        makeWorktree({ path: SECOND_SCRATCH_PATH, displayName: 'scratch-2' })
      ])
    }
    await renderDialog()

    const section = sectionByTitle('Agent scratch worktrees')
    expect(section.textContent).toContain('Partly shown in sidebar')
    expect(section.textContent).toContain('1 of 2 shown')
  })

  it('flips the repo setting from the other-worktrees switch and leaves the dialog open', async () => {
    await renderDialog()

    await click(buttonIn(sectionByTitle('Other worktrees'), 'Show all'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show',
      externalWorktreeDiscoverySuppressedAt: null
    })
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('drops the other-kind imports when hiding them all so none survive the switch', async () => {
    mocks.state.repos = [
      makeRepo({
        externalWorktreeVisibility: 'show',
        importedExternalWorktreePaths: [EXTERNAL_PATH, SCRATCH_PATH]
      })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree({
          path: EXTERNAL_PATH,
          displayName: 'manual',
          ownership: 'external',
          visible: true
        })
      ])
    }
    await renderDialog()

    await click(buttonIn(sectionByTitle('Other worktrees'), 'Hide all'))

    expect(mocks.state.updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: [SCRATCH_PATH],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH, EXTERNAL_PATH]
    })
  })

  it('drops the per-worktree list for other worktrees once the setting shows them all', async () => {
    mocks.state.repos = [makeRepo({ externalWorktreeVisibility: 'show' })]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([
        makeWorktree(),
        makeWorktree({
          path: EXTERNAL_PATH,
          displayName: 'manual',
          ownership: 'external',
          visible: true
        })
      ])
    }
    await renderDialog()

    expect(buttonIn(sectionByTitle('Other worktrees'), 'Hide all')).toBeTruthy()
    expect(() => buttonIn(sectionByTitle('Other worktrees'), 'Manage individually')).toThrow()
    expect(buttonIn(sectionByTitle('Agent scratch worktrees'), 'Manage individually')).toBeTruthy()
  })

  it('surfaces a failure inline and keeps the row actionable', async () => {
    mocks.state.updateRepo.mockResolvedValue(false)
    await renderDialog()
    await expandIndividualWorktrees('Agent scratch worktrees')

    await click(buttonByLabel('Show scratch-1 in the sidebar'))

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not import external worktrees. Try again.'
    )
    expect(buttonByLabel('Show scratch-1 in the sidebar').disabled).toBe(false)
  })

  it('shows the primer until it is dismissed, then keeps it reachable', async () => {
    mocks.state.nonOrcaWorktreeGuideDismissed = false
    await renderDialog()

    expect(document.body.textContent).toContain(
      'Anything created through Orca always shows in the sidebar'
    )
    expect(
      [...document.querySelectorAll('button')].map((button) => button.textContent)
    ).not.toContain('What is this?')

    await click(buttonIn(document, 'Got it'))

    expect(mocks.state.dismissNonOrcaWorktreeGuide).toHaveBeenCalled()

    mocks.state.nonOrcaWorktreeGuideDismissed = true
    await renderDialog()

    expect(document.body.textContent).not.toContain(
      'Anything created through Orca always shows in the sidebar'
    )

    await click(buttonIn(document, 'What is this?'))

    expect(document.body.textContent).toContain(
      'Anything created through Orca always shows in the sidebar'
    )
  })

  it('refreshes instead of claiming nothing is hidden when the snapshot is a fallback', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], {
        authoritative: false,
        source: 'session-fallback'
      })
    }
    await renderDialog()

    expect(document.body.textContent).toContain('Checking…')
    expect(document.body.textContent).not.toContain('None in this repo.')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true
    })
  })

  it('says the list could not be read and offers a way out of the dead end', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not list this repo's worktrees."
    )
    expect(document.body.textContent).toContain('Not available')
    expect(document.body.textContent).not.toContain('Checking…')

    mocks.state.fetchWorktrees.mockResolvedValue(true)
    await click(buttonIn(document, 'Try again'))

    expect(mocks.state.fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('refuses a bulk flip while the list cannot be trusted, since hiding purges imports', async () => {
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetected([makeWorktree()], { authoritative: false, source: 'session-fallback' })
    }
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()

    for (const title of ['Agent scratch worktrees', 'Other worktrees']) {
      expect(buttonIn(sectionByTitle(title), 'Show all').disabled).toBe(true)
    }
  })

  it('waits for persisted UI before showing the primer, so a dismissal is not flashed away', async () => {
    mocks.state.nonOrcaWorktreeGuideDismissed = false
    mocks.state.persistedUIReady = false
    await renderDialog()

    expect(document.body.textContent).not.toContain('Anything created through Orca')

    mocks.state.persistedUIReady = true
    await renderDialog()

    expect(document.body.textContent).toContain('Anything created through Orca')
  })
})
