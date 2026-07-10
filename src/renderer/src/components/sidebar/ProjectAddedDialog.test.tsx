import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'project-added',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    repos: [] as Repo[],
    worktreesByRepo: {} as Record<string, unknown[]>,
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn()
  },
  activateAndRevealWorktree: vi.fn(),
  finishProjectAddWithDefaultCheckout: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('./project-added-default-checkout', () => ({
  finishProjectAddWithDefaultCheckout: mocks.finishProjectAddWithDefaultCheckout
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ProjectAddedDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'project-added'
    mocks.state.modalData = { repoId: 'repo-1' }
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = {}
    mocks.state.fetchRepos.mockResolvedValue(undefined)
    mocks.state.fetchWorktrees.mockResolvedValue(true)
  })

  it('fetches worktrees and finishes by opening the default checkout for Git repos', async () => {
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(markup).toBe('')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1')
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: 'repo-1',
      source: 'project_added_compat',
      closeModal: mocks.state.closeModal,
      setHideDefaultBranchWorkspace: mocks.state.setHideDefaultBranchWorkspace
    })
  })

  it('does not block the compatibility handoff during StrictMode effect replay', async () => {
    const cleanupFns: (() => void)[] = []
    vi.doMock('react', async (importOriginal) => {
      const actual = await importOriginal<typeof ReactModule>()
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          const cleanup = effect()
          if (cleanup) {
            cleanupFns.push(cleanup)
          }
        }
      }
    })
    vi.resetModules()
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    renderToStaticMarkup(<ProjectAddedDialog />)
    cleanupFns.pop()?.()
    renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(mocks.state.fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledTimes(1)
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: 'repo-1',
      source: 'project_added_compat',
      closeModal: mocks.state.closeModal,
      setHideDefaultBranchWorkspace: mocks.state.setHideDefaultBranchWorkspace
    })
  })

  it('accepts older onboarding modal data that uses projectId', async () => {
    mocks.state.modalData = { projectId: 'repo-1' }
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1')
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-1' })
    )
  })

  it('activates the synthetic folder workspace for folder repos', async () => {
    mocks.state.repos = [makeRepo({ kind: 'folder' })]
    mocks.state.worktreesByRepo = {
      'repo-1': [{ id: 'repo-1::folder' }]
    }
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(markup).toBe('')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::folder')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.finishProjectAddWithDefaultCheckout).not.toHaveBeenCalled()
  })

  it('closes malformed modal data without blocking the app invisibly', async () => {
    mocks.state.modalData = {}
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(markup).toBe('')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('refreshes repos before closing a stale repo id', async () => {
    mocks.state.repos = []
    mocks.state.fetchRepos.mockImplementation(async () => {
      mocks.state.repos = []
    })
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(mocks.state.fetchRepos).toHaveBeenCalledTimes(1)
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  it('waits for repo hydration and does not close when fetchRepos supplies the repo', async () => {
    mocks.state.repos = []
    mocks.state.fetchRepos.mockImplementation(async () => {
      mocks.state.repos = [makeRepo()]
    })
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    renderToStaticMarkup(<ProjectAddedDialog />)
    await flushPromises()

    expect(mocks.state.fetchRepos).toHaveBeenCalledTimes(1)
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
    expect(mocks.finishProjectAddWithDefaultCheckout).not.toHaveBeenCalled()
  })
})
