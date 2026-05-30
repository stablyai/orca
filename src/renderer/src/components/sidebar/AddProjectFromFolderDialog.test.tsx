import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

type ButtonCapture = {
  label: string
  onClick?: () => unknown
  disabled?: boolean
}

const mocks = vi.hoisted(() => ({
  buttons: [] as ButtonCapture[],
  state: {
    activeModal: 'confirm-add-project-from-folder',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    openModal: vi.fn(),
    addRepoPath: vi.fn(),
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    worktreesByRepo: {} as Record<string, Worktree[]>,
    detectedWorktreesByRepo: {},
    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: vi.fn(),
    clearOrcaHookTrustForRepo: vi.fn(),
    repos: [] as Repo[]
  },
  addRemote: vi.fn(),
  toastSuccess: vi.fn(),
  track: vi.fn()
}))

function textContent(node: ReactModule.ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('')
  }
  if (typeof node === 'object' && 'props' in node) {
    return textContent((node as { props?: { children?: ReactModule.ReactNode } }).props?.children)
  }
  return ''
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state,
      setState: (next: Partial<typeof mocks.state>) => {
        Object.assign(mocks.state, next)
      }
    }
  )
  return { useAppStore }
})

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactModule.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactModule.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: {
    children: ReactModule.ReactNode
    onClick?: () => unknown
    disabled?: boolean
  }) => {
    mocks.buttons.push({ label: textContent(children), onClick, disabled })
    return (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    )
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('./AddRepoSetupStep', () => ({
  SetupStep: ({ repoName }: { repoName: string }) => <div>setup:{repoName}</div>,
  getProjectAddedPrimaryBranchName: () => 'main'
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/projects/child',
    displayName: 'child',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

async function clickAddProject(): Promise<void> {
  const button = mocks.buttons.find((entry) => entry.label.includes('Add Project'))
  if (!button?.onClick) {
    throw new Error('Add Project button not found')
  }
  await button.onClick()
}

describe('AddProjectFromFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buttons = []
    mocks.state.activeModal = 'confirm-add-project-from-folder'
    mocks.state.modalData = { folderPath: '/projects/child' }
    mocks.state.worktreesByRepo = {}
    mocks.state.detectedWorktreesByRepo = {}
    mocks.state.hideDefaultBranchWorkspace = false
    mocks.state.repos = []
    vi.stubGlobal('window', {
      api: {
        repos: {
          addRemote: mocks.addRemote
        }
      }
    })
  })

  it('adds a local Git folder and opens the reused setup step data path', async () => {
    const repo = makeRepo()
    mocks.state.addRepoPath.mockResolvedValue(repo)
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.state.addRepoPath).toHaveBeenCalledWith('/projects/child')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id)
    expect(mocks.state.openModal).not.toHaveBeenCalledWith(
      'confirm-non-git-folder',
      expect.anything()
    )
  })

  it('leaves local non-Git folders on the existing Open as Folder confirmation path', async () => {
    mocks.state.addRepoPath.mockImplementation(async (folderPath: string) => {
      mocks.state.openModal('confirm-non-git-folder', { folderPath })
      return null
    })
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.state.addRepoPath).toHaveBeenCalledWith('/projects/child')
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-non-git-folder', {
      folderPath: '/projects/child'
    })
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('adds an SSH Git folder through the remote repo import path', async () => {
    const repo = makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' })
    mocks.state.modalData = {
      folderPath: '/srv/projects/child',
      connectionId: 'ssh-target-1'
    }
    mocks.addRemote.mockResolvedValue({ repo })
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.addRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-target-1',
      remotePath: '/srv/projects/child'
    })
    expect(mocks.state.repos).toEqual([repo])
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Remote project added', {
      description: repo.displayName
    })
  })

  it('sends SSH non-Git folders to the Open as Folder confirmation with the connection id', async () => {
    mocks.state.modalData = {
      folderPath: '/srv/projects/docs',
      connectionId: 'ssh-target-1'
    }
    mocks.addRemote.mockResolvedValue({
      error: 'Not a valid git repository: /srv/projects/docs'
    })
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.addRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-target-1',
      remotePath: '/srv/projects/docs'
    })
    expect(mocks.state.closeModal).toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-non-git-folder', {
      folderPath: '/srv/projects/docs',
      connectionId: 'ssh-target-1'
    })
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })
})
