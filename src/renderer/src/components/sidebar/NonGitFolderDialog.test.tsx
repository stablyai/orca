import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }]
  }
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

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

import NonGitFolderDialog from './NonGitFolderDialog'

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
})
