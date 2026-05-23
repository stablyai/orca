import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'project-added',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    openModal: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    repos: [] as Repo[],
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn(),
    detectedWorktreesByRepo: {}
  }
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
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactModule.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>
}))

vi.mock('./AddRepoSetupStep', () => ({
  ProjectAddedContent: ({ repoName }: { repoName: string }) => <div>setup:{repoName}</div>
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

describe('ProjectAddedDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'project-added'
    mocks.state.modalData = { repoId: 'repo-1' }
    mocks.state.repos = [makeRepo()]
    mocks.state.detectedWorktreesByRepo = {}
  })

  it('renders the Git setup step for Git repos', async () => {
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)

    expect(markup).toContain('setup:orca')
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('closes without rendering Git setup for folder repos', async () => {
    mocks.state.repos = [makeRepo({ kind: 'folder' })]
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)

    expect(markup).toBe('')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })
})
