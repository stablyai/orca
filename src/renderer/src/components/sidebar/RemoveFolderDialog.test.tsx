import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'confirm-remove-folder' as string | null,
    modalData: {
      repoId: 'repo-1',
      displayName: 'Example',
      hostId: 'ssh:target-1'
    } as Record<string, unknown>,
    repos: [] as Repo[],
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>(),
    closeModal: vi.fn(),
    removeProject: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

import RemoveFolderDialog from './RemoveFolderDialog'

function repo(connectionId: string | null, executionHostId: Repo['executionHostId']): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/example',
    displayName: 'Example',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    connectionId,
    executionHostId
  }
}

describe('RemoveFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.modalData = {
      repoId: 'repo-1',
      displayName: 'Example',
      hostId: 'ssh:target-1'
    }
    mocks.state.sshTargetLabels = new Map([['target-1', 'Persistent host']])
    mocks.state.removedSshTargetLabels = new Map()
  })

  it('warns that VM recipe cleanup controls file deletion', () => {
    mocks.state.modalData.hostId = 'ssh:runtime-ssh-runtime-1'
    mocks.state.repos = [repo('runtime-ssh-runtime-1', 'ssh:runtime-ssh-runtime-1')]

    const html = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(html).toContain('Its VM recipe determines whether the environment')
    expect(html).toContain('files are permanently deleted')
    expect(html).not.toContain('Its files stay on')
  })

  it('keeps the file-preservation promise for ordinary SSH projects', () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]

    const html = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(html).toContain('Its files stay on Persistent host')
    expect(html).not.toContain('VM recipe')
  })
})
