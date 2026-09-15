// @vitest-environment happy-dom

import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    removeProject: vi.fn(),
    updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
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
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  )
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
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.repos = [repo(null, 'local')]
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
    expect(html).not.toContain('checkbox')
  })

  it('keeps the file-preservation promise for ordinary SSH projects', () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]

    const html = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(html).toContain('Its files stay on Persistent host')
    expect(html).not.toContain('VM recipe')
  })

  it('saves the preference only when checked and confirmed', () => {
    render(<RemoveFolderDialog />)
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    expect(mocks.state.updateSettingsOrThrow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledWith({
      skipRemoveProjectConfirm: true
    })
    expect(mocks.state.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: 'ssh:target-1',
      errorFeedback: 'toast'
    })
    expect(mocks.state.closeModal).toHaveBeenCalled()
  })

  it('does not save the preference or remove the project on cancel', () => {
    render(<RemoveFolderDialog />)
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.state.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(mocks.state.removeProject).not.toHaveBeenCalled()
    expect(mocks.state.closeModal).toHaveBeenCalled()
  })

  it('leaves confirmation enabled when removing without checking', () => {
    render(<RemoveFolderDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mocks.state.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(mocks.state.removeProject).toHaveBeenCalledTimes(1)
  })

  it('starts unchecked when a cancelled dialog is mounted again', () => {
    const first = render(<RemoveFolderDialog />)
    fireEvent.click(screen.getByRole('checkbox'))
    first.unmount()
    render(<RemoveFolderDialog />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
  })
})
