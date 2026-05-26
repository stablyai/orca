import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

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
    detectedWorktreesByRepo: {},
    worktreesByRepo: {} as Record<string, Worktree[]>,
    setHideDefaultBranchWorkspace: vi.fn()
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

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactModule.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>
}))

vi.mock('./AddRepoSetupStep', () => ({
  ProjectAddedContent: ({
    repoName,
    primaryBranchName
  }: {
    repoName: string
    primaryBranchName?: string
  }) => (
    <div>
      setup:{repoName}:{primaryBranchName ?? ''}
    </div>
  ),
  getProjectAddedPrimaryBranchName: (worktree: Pick<Worktree, 'branch'> | null | undefined) =>
    worktree?.branch.replace(/^refs\/heads\//, '').trim() ?? ''
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
    mocks.state.worktreesByRepo = {}
  })

  it('renders the Git setup step for Git repos', async () => {
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)

    expect(markup).toContain('setup:orca')
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('passes the primary branch name to the setup step', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [
        {
          id: 'repo-1::/repo',
          repoId: 'repo-1',
          path: '/repo',
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          head: 'abc',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]
    }
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)

    expect(markup).toContain('setup:orca:main')
  })

  it('closes without rendering Git setup for folder repos', async () => {
    mocks.state.repos = [makeRepo({ kind: 'folder' })]
    const { default: ProjectAddedDialog } = await import('./ProjectAddedDialog')

    const markup = renderToStaticMarkup(<ProjectAddedDialog />)

    expect(markup).toBe('')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })
})
