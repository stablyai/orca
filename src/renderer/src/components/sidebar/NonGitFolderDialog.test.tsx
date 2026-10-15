import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

type ButtonCapture = {
  label: string
  onClick?: () => unknown
}

const mocks = vi.hoisted(() => ({
  buttons: [] as ButtonCapture[],
  state: {
    activeModal: 'confirm-non-git-folder',
    modalData: {
      folderPath: '/srv/non-git',
      runtimeEnvironmentId: 'env-1'
    } as Record<string, unknown>,
    closeModal: vi.fn(),
    addNonGitFolder: vi.fn(),
    runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }],
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: [],
    worktreesByRepo: {} as Record<string, Worktree[]>,
    fetchWorktrees: vi.fn(),
    settings: {}
  },
  addRemote: vi.fn(),
  addRuntimeSshRepo: vi.fn(),
  onboardingGet: vi.fn(),
  activateAndRevealWorktree: vi.fn()
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
  // Rendered even while the Perforce check gates `open`; static markup never runs that effect.
  Dialog: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactModule.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: ReactModule.ReactNode; onClick?: () => unknown }) => {
    mocks.buttons.push({ label: textContent(children), onClick })
    return <button onClick={onClick}>{children}</button>
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-ssh-target-management', () => ({
  addRuntimeSshRepo: mocks.addRuntimeSshRepo
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { toast } from 'sonner'
import NonGitFolderDialog from './NonGitFolderDialog'

function makeWorktree(id: string, path: string, hostId: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'shared-repo',
    path,
    hostId,
    displayName: 'Folder',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: true
  }
}

describe('NonGitFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buttons.length = 0
    mocks.state.activeModal = 'confirm-non-git-folder'
    mocks.state.modalData = {
      folderPath: '/srv/non-git',
      runtimeEnvironmentId: 'env-1'
    }
    mocks.state.runtimeEnvironments = [{ id: 'env-1', name: 'Remote Mac' }]
    mocks.state.repos = []
    mocks.state.projects = []
    mocks.state.projectHostSetups = []
    mocks.state.worktreesByRepo = {}
    mocks.state.fetchWorktrees.mockResolvedValue(true)
    mocks.onboardingGet.mockResolvedValue(null)
    vi.stubGlobal('window', {
      api: {
        repos: { addRemote: mocks.addRemote },
        perforce: { detectFolder: vi.fn().mockResolvedValue({ isWorkspace: false }) },
        onboarding: { get: mocks.onboardingGet }
      }
    })
  })

  it('shows the checked host in the folder confirmation', () => {
    const html = renderToStaticMarkup(<NonGitFolderDialog />)

    expect(html).toContain('Remote Mac')
    expect(html).toContain('/srv/non-git')
  })

  it('confirms runtime folder imports on the checked host', () => {
    renderToStaticMarkup(<NonGitFolderDialog />)

    const button = mocks.buttons.find((entry) => entry.label.includes('Open as Folder'))
    button?.onClick?.()

    expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith('/srv/non-git', {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.state.closeModal).toHaveBeenCalled()
  })

  it('names the runtime folder project after the requested display name', () => {
    mocks.state.modalData = {
      folderPath: '/srv/non-git',
      runtimeEnvironmentId: 'env-1',
      displayName: 'inf-오케스트레이터'
    }
    renderToStaticMarkup(<NonGitFolderDialog />)

    const button = mocks.buttons.find((entry) => entry.label.includes('Open as Folder'))
    button?.onClick?.()

    expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith('/srv/non-git', {
      runtimeEnvironmentId: 'env-1',
      displayName: 'inf-오케스트레이터'
    })
  })

  it("adds a folder on a server's SSH host through that server, named as requested", async () => {
    mocks.state.modalData = {
      folderPath: '/srv/non-git',
      connectionId: 'ssh-1',
      runtimeEnvironmentId: 'env-1',
      displayName: 'inf-오케스트레이터'
    }
    mocks.addRuntimeSshRepo.mockResolvedValue({
      id: 'ssh-repo',
      path: '/srv/non-git',
      displayName: 'inf-오케스트레이터',
      badgeColor: '#111',
      addedAt: 1,
      kind: 'folder'
    } satisfies Repo)
    renderToStaticMarkup(<NonGitFolderDialog />)

    const button = mocks.buttons.find((entry) => entry.label.includes('Open as Folder'))
    button?.onClick?.()

    await vi.waitFor(() =>
      expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('ssh-repo', {
        requireAuthoritative: true,
        executionHostId: 'runtime:env-1'
      })
    )
    expect(mocks.addRuntimeSshRepo).toHaveBeenCalledWith('env-1', {
      connectionId: 'ssh-1',
      remotePath: '/srv/non-git',
      kind: 'folder',
      displayName: 'inf-오케스트레이터'
    })
    expect(mocks.state.repos).toContainEqual(
      expect.objectContaining({ id: 'ssh-repo', executionHostId: 'runtime:env-1' })
    )
    expect(mocks.addRemote).not.toHaveBeenCalled()
    expect(mocks.state.addNonGitFolder).not.toHaveBeenCalled()
  })

  it("activates only the server's SSH folder when repo IDs collide", async () => {
    const repo: Repo = {
      id: 'shared-repo',
      path: '/srv/non-git',
      displayName: 'SSH folder',
      badgeColor: '#111',
      addedAt: 1,
      kind: 'folder'
    }
    const localWorktree = makeWorktree('shared-repo::/local/non-git', '/local/non-git', 'local')
    const serverWorktree = makeWorktree(
      'shared-repo::/srv/non-git',
      '/srv/non-git',
      'runtime:env-1'
    )
    mocks.state.modalData = {
      folderPath: '/srv/non-git',
      connectionId: 'ssh-1',
      runtimeEnvironmentId: 'env-1'
    }
    mocks.state.repos = [
      { ...repo, path: '/local/non-git', connectionId: null, executionHostId: 'local' }
    ]
    mocks.addRuntimeSshRepo.mockResolvedValue(repo)
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = { [repo.id]: [localWorktree, serverWorktree] }
      return true
    })
    renderToStaticMarkup(<NonGitFolderDialog />)

    const button = mocks.buttons.find((entry) => entry.label.includes('Open as Folder'))
    button?.onClick?.()

    await vi.waitFor(() =>
      expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(serverWorktree.id, {
        sidebarRevealBehavior: 'auto',
        executionHostId: 'runtime:env-1'
      })
    )
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalledWith(
      localWorktree.id,
      expect.anything()
    )
  })

  it('refuses an SSH folder with no server to add it, never adding it on this computer', async () => {
    mocks.state.modalData = { folderPath: '/srv/non-git', connectionId: 'ssh-1' }
    renderToStaticMarkup(<NonGitFolderDialog />)

    const button = mocks.buttons.find((entry) => entry.label.includes('Open as Folder'))
    button?.onClick?.()

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('SSH connection "ssh-1" not found or not connected')
    )
    expect(mocks.addRemote).not.toHaveBeenCalled()
    expect(mocks.addRuntimeSshRepo).not.toHaveBeenCalled()
    expect(mocks.state.addNonGitFolder).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })
})
