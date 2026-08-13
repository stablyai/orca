import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'confirm-remove-folder' as string | null,
    modalData: { repoId: 'repo-1', displayName: 'Cloud workspace' } as Record<string, unknown>,
    closeModal: vi.fn(),
    removeProject: vi.fn(),
    repos: [
      {
        id: 'repo-1',
        connectionId: null as string | null,
        executionHostId: undefined as string | undefined
      }
    ],
    worktreesByRepo: {} as Record<string, { hostId?: string; ephemeralVmCheckoutMode?: string }[]>,
    settings: { activeRuntimeEnvironmentId: null as string | null },
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{name}}', values?.name ?? '').replace('{{host}}', values?.host ?? '')
}))

describe('RemoveFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.modalData = { repoId: 'repo-1', displayName: 'Cloud workspace' }
    mocks.state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: undefined }]
    mocks.state.worktreesByRepo = {}
  })

  it('warns that removing a provisioned root runs recipe cleanup', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [{ ephemeralVmCheckoutMode: 'provisioned-root' }]
    }
    const { default: RemoveFolderDialog } = await import('./RemoveFolderDialog')

    const markup = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(markup).toContain('cleans up its provisioned environment according to the recipe')
    expect(markup).not.toContain('still on your disk')
  })

  it('keeps the local-project retention copy', async () => {
    const { default: RemoveFolderDialog } = await import('./RemoveFolderDialog')

    const markup = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(markup).toContain('still on your disk')
  })

  it('keeps local retention copy when a same-id sibling host is provisioned', async () => {
    mocks.state.modalData = {
      repoId: 'repo-1',
      displayName: 'Local workspace',
      hostId: 'local'
    }
    mocks.state.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: undefined },
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }
    ]
    mocks.state.worktreesByRepo = {
      'repo-1': [
        {
          hostId: 'runtime:env-1',
          ephemeralVmCheckoutMode: 'provisioned-root'
        }
      ]
    }
    const { default: RemoveFolderDialog } = await import('./RemoveFolderDialog')

    const markup = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(markup).toContain('still on your disk')
    expect(markup).not.toContain('cleans up its provisioned environment')
  })
})
