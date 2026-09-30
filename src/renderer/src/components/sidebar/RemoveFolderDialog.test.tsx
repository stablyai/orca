// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => {
  const runtimeEnvironments: { id: string; name: string }[] = []
  return {
    state: {
      activeModal: 'confirm-remove-folder' as string | null,
      modalData: {
        repoId: 'repo-1',
        displayName: 'Example',
        hostId: 'ssh:target-1'
      } as Record<string, unknown>,
      repos: [] as Repo[],
      // Read by selectExecutionHostDisplayLabel: a per-host rename override wins over the name.
      settings: null,
      runtimeEnvironments,
      sshTargetLabels: new Map<string, string>(),
      removedSshTargetLabels: new Map<string, string>(),
      closeModal: vi.fn(),
      removeProject: vi.fn()
    }
  }
})

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
  Button: ({
    children,
    onClick,
    disabled
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
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
    cleanup()
    vi.clearAllMocks()
    mocks.state.modalData = {
      repoId: 'repo-1',
      displayName: 'Example',
      hostId: 'ssh:target-1'
    }
    mocks.state.repos = []
    mocks.state.runtimeEnvironments = []
    mocks.state.sshTargetLabels = new Map([['target-1', 'Persistent host']])
    mocks.state.removedSshTargetLabels = new Map()
    mocks.state.removeProject.mockResolvedValue({ status: 'removed' })
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

  it('closes on a removal the owning host confirmed', async () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(mocks.state.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: 'ssh:target-1',
      errorFeedback: 'toast'
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  // The owning runtime never answered, so the project is still registered there. The
  // dialog must stay open and name the host rather than close on a removal that did not happen.
  it('re-offers a client-only forget when the owning host never answers', async () => {
    mocks.state.modalData.hostId = 'runtime:env-1'
    mocks.state.repos = [repo(null, 'runtime:env-1')]
    mocks.state.runtimeEnvironments = [{ id: 'env-1', name: 'devbox' }]
    mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(mocks.state.closeModal).not.toHaveBeenCalled()
    // Names the host, and claims nothing about what it did: a timeout may have lost the reply to a
    // removal that landed, while a manual disconnect never sent the request at all.
    expect(screen.getByText(/Orca could not confirm with devbox whether/)).toBeInTheDocument()
    expect(screen.queryByText(/reply lost|never have arrived/)).not.toBeInTheDocument()
    expect(screen.getByText(/if the project is still registered there/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove from Orca' }))

    expect(mocks.state.removeProject).toHaveBeenLastCalledWith('repo-1', {
      hostId: 'runtime:env-1',
      errorFeedback: 'toast',
      mode: 'forget-local'
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  // The owner-unverifiable sentence interpolated a label that only a `runtime:` hostId produced,
  // so every other opener rendered "Orca could not reach , so whether …".
  it('names an ssh owner that never answered', async () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]
    mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText(/Orca could not confirm with Persistent host/)).toBeInTheDocument()
    expect(screen.queryByText(/could not confirm with ,/)).not.toBeInTheDocument()
  })

  it('names the owner when the modal was opened without a hostId', async () => {
    delete mocks.state.modalData.hostId
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]
    mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText(/Orca could not confirm with Persistent host/)).toBeInTheDocument()
  })

  // The unreachable runtime is exactly the case whose environment record may be gone, and the
  // label resolver answers the raw routing id when it is.
  it('falls back to a generic host name instead of a raw runtime id', async () => {
    mocks.state.modalData.hostId = 'runtime:env-a1b2'
    mocks.state.repos = [repo(null, 'runtime:env-a1b2')]
    mocks.state.runtimeEnvironments = []
    mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
    const view = render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText(/Orca could not confirm with that host/)).toBeInTheDocument()
    expect(view.container.textContent).not.toContain('env-a1b2')
  })

  // A paired web client's records are the runtime's own catalog, so repos.removeForHost throws
  // there and the forget could only ever fail. Explain, do not offer.
  it('withholds the client-only forget in a paired web client', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    try {
      mocks.state.modalData.hostId = 'runtime:env-1'
      mocks.state.repos = [repo(null, 'runtime:env-1')]
      mocks.state.runtimeEnvironments = [{ id: 'env-1', name: 'devbox' }]
      mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
      render(<RemoveFolderDialog />)

      await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(screen.queryByRole('button', { name: 'Remove from Orca' })).not.toBeInTheDocument()
      expect(screen.getByText(/keeps no records of its own to clear/)).toBeInTheDocument()
      expect(mocks.state.removeProject).toHaveBeenCalledTimes(1)
      expect(mocks.state.closeModal).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // An unreachable owner can hold the call for the full 15s timeout, but a local removal returns
  // instantly — bind the disabled state now and the visible one on a timer (docs/STYLEGUIDE.md).
  it('delays the pending spinner so a fast removal does not flicker', async () => {
    vi.useFakeTimers()
    try {
      mocks.state.repos = [repo('target-1', 'ssh:target-1')]
      let finishRemoval: ((outcome: { status: string }) => void) | undefined
      mocks.state.removeProject.mockReturnValueOnce(
        new Promise((resolve) => {
          finishRemoval = resolve
        })
      )
      const view = render(<RemoveFolderDialog />)

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
      expect(view.container.querySelector('.animate-spin')).toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(199)
      })
      expect(view.container.querySelector('.animate-spin')).toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(view.container.querySelector('.animate-spin')).not.toBeNull()

      await act(async () => {
        finishRemoval?.({ status: 'removed' })
      })
      expect(view.container.querySelector('.animate-spin')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // Cancel stays live during the ~15s host call. closeModal is global, so a late answer from a
  // dismissed invocation must not dismiss whichever dialog the user opened next.
  it('ignores a removal that finishes after its dialog was dismissed', async () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]
    let finishRemoval: ((outcome: { status: string }) => void) | undefined
    mocks.state.removeProject.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRemoval = resolve
      })
    )
    const view = render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    view.unmount()
    finishRemoval?.({ status: 'removed' })
    await Promise.resolve()

    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })
})
