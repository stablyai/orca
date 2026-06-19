import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

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
    fetchWorktrees: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    clearOrcaHookTrustForRepo: vi.fn(),
    repos: [] as Repo[]
  },
  addRemote: vi.fn(),
  toastSuccess: vi.fn(),
  finishProjectAddWithDefaultCheckout: vi.fn()
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

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('./project-added-default-checkout', () => ({
  finishProjectAddWithDefaultCheckout: mocks.finishProjectAddWithDefaultCheckout
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

function getButton(label: string): ButtonCapture {
  const button = mocks.buttons.find((entry) => entry.label.includes(label))
  if (!button?.onClick) {
    throw new Error(`${label} button not found`)
  }
  return button
}

describe('AddProjectFromFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buttons = []
    mocks.state.activeModal = 'confirm-add-project-from-folder'
    mocks.state.modalData = { folderPath: '/projects/child' }
    mocks.state.repos = []
    mocks.state.fetchWorktrees.mockResolvedValue(true)
    vi.stubGlobal('window', {
      api: {
        repos: {
          addRemote: mocks.addRemote
        }
      }
    })
  })

  it('adds a local Git folder and opens the default checkout', async () => {
    const repo = makeRepo()
    mocks.state.addRepoPath.mockResolvedValue(repo)
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.state.addRepoPath).toHaveBeenCalledWith('/projects/child')
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: repo.id,
      source: 'local_folder_picker',
      closeModal: mocks.state.closeModal,
      setHideDefaultBranchWorkspace: mocks.state.setHideDefaultBranchWorkspace
    })
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
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: repo.id,
      source: 'ssh_remote_path',
      closeModal: mocks.state.closeModal,
      setHideDefaultBranchWorkspace: mocks.state.setHideDefaultBranchWorkspace
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Project added on SSH host', {
      description: repo.displayName
    })
  })

  it('falls back to completion when Git worktree refresh is not authoritative', async () => {
    const repo = makeRepo()
    mocks.state.addRepoPath.mockResolvedValue(repo)
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    await clickAddProject()

    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: repo.id,
      source: 'local_folder_picker',
      closeModal: mocks.state.closeModal,
      setHideDefaultBranchWorkspace: mocks.state.setHideDefaultBranchWorkspace
    })
  })

  it('does not finish the handoff after the user cancels during refresh', async () => {
    const repo = makeRepo()
    let resolveRefresh: (value: boolean) => void = () => {}
    mocks.state.addRepoPath.mockResolvedValue(repo)
    mocks.state.fetchWorktrees.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRefresh = resolve
      })
    )
    const { default: AddProjectFromFolderDialog } = await import('./AddProjectFromFolderDialog')

    renderToStaticMarkup(<AddProjectFromFolderDialog />)
    const addPromise = getButton('Add Project').onClick?.()
    await Promise.resolve()
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    getButton('Cancel').onClick?.()
    resolveRefresh(true)
    await addPromise

    expect(mocks.finishProjectAddWithDefaultCheckout).not.toHaveBeenCalled()
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
