// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authStatus: {
    activeProfileId: 'profile-a',
    cloud: { cloudProfileId: 'cloud-a', userId: 'user-a' },
    configured: true,
    state: 'connected'
  } as Record<string, unknown>,
  closePage: vi.fn(),
  connect: vi.fn(),
  confirm: vi.fn(),
  refreshAuth: vi.fn(),
  rpc: vi.fn(),
  settings: {
    artifactSharingEnabled: true,
    skipDeleteArtifactConfirm: false
  } as Record<string, unknown> | null,
  updateSettings: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  resolvePartition: vi.fn(),
  writeClipboardText: vi.fn(),
  openUrl: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.rpc
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState()),
    { getState: storeState }
  )
}))

function storeState(): Record<string, unknown> {
  return {
    closeArtifactsPage: mocks.closePage,
    connectCurrentOrcaProfile: mocks.connect,
    orcaProfileAuthStatus: mocks.authStatus,
    refreshCurrentOrcaProfileAuth: mocks.refreshAuth,
    settings: mocks.settings,
    updateSettings: mocks.updateSettings,
    openSettingsPage: mocks.openSettingsPage,
    openSettingsTarget: mocks.openSettingsTarget
  }
}

import ArtifactsPage from './ArtifactsPage'

describe('ArtifactsPage', () => {
  beforeEach(() => {
    mocks.authStatus = {
      activeProfileId: 'profile-a',
      cloud: { cloudProfileId: 'cloud-a', userId: 'user-a' },
      configured: true,
      state: 'connected'
    }
    mocks.closePage.mockReset()
    mocks.connect.mockReset()
    mocks.confirm.mockReset()
    mocks.refreshAuth.mockReset()
    mocks.rpc.mockReset()
    mocks.settings = { artifactSharingEnabled: true, skipDeleteArtifactConfirm: false }
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.openSettingsPage.mockReset()
    mocks.openSettingsTarget.mockReset()
    mocks.resolvePartition.mockReset().mockResolvedValue('persist:orca-default')
    mocks.writeClipboardText.mockReset().mockResolvedValue(undefined)
    mocks.openUrl.mockReset().mockResolvedValue(undefined)
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    Object.assign(window, {
      api: {
        browser: { sessionResolvePartition: mocks.resolvePartition },
        ui: { writeClipboardText: mocks.writeClipboardText },
        shell: { openUrl: mocks.openUrl }
      }
    })
    mocks.rpc.mockResolvedValue({
      status: 'ok',
      value: {
        artifacts: [
          {
            artifact: {
              byteSize: 1024,
              createdAt: '2026-08-01T12:00:00.000Z',
              deletedAt: null,
              expiresAt: '2026-09-01T12:00:00.000Z',
              originalFileName: 'report.html',
              renderedContentType: 'text/html',
              slug: 'report-123',
              sourceContentType: 'text/html',
              title: 'Quarterly report',
              updatedAt: '2026-08-02T12:00:00.000Z',
              version: 1
            },
            shareUrl: 'https://share.onorca.dev/a/report-123'
          }
        ]
      }
    })
  })

  afterEach(cleanup)

  it('closes the drawer on Escape, then the page', async () => {
    render(<ArtifactsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly report/ }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Quarterly report' })
    ).toBeInTheDocument()

    fireEvent.keyDown(document.querySelector('[data-slot="sheet-content"]') as Element, {
      key: 'Escape'
    })
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Quarterly report' })).toBeNull()
    )
    expect(mocks.closePage).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(mocks.closePage).toHaveBeenCalledOnce()
  })

  it('loads each cursor once and appends the next artifact page', async () => {
    let resolveNextPage!: (value: unknown) => void
    mocks.rpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          artifacts: [artifactListItem('First page', 'first-page')],
          nextCursor: 'opaque cursor'
        }
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNextPage = resolve
        })
      )
    render(<ArtifactsPage />)

    await screen.findAllByText('First page')
    const loadMore = screen.getByRole('button', { name: 'Load more' })
    fireEvent.click(loadMore)
    fireEvent.click(loadMore)

    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'artifacts.list', {
      cursor: 'opaque cursor'
    })
    resolveNextPage({
      status: 'ok',
      value: { artifacts: [artifactListItem('Second page', 'second-page')] }
    })

    expect(await screen.findByRole('button', { name: /Second page/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /First page/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('can continue from an empty page that has a next cursor', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: { artifacts: [], nextCursor: 'after-empty-page' }
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: { artifacts: [artifactListItem('Older artifact', 'older-artifact')] }
      })
    render(<ArtifactsPage />)

    expect(await screen.findByText('More artifacts are available')).toBeInTheDocument()
    expect(screen.queryByText('No shared artifacts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByRole('button', { name: /Older artifact/ })).toBeInTheDocument()
  })

  it('keeps loaded artifacts when loading another page fails', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          artifacts: [artifactListItem('Still visible', 'still-visible')],
          nextCursor: 'next-page'
        }
      })
      .mockRejectedValueOnce(new Error('network down'))
    render(<ArtifactsPage />)

    await screen.findByRole('button', { name: /Still visible/ })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Could not load more artifacts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Still visible/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled()
  })

  it('does not surface an initial auth error after the account changes during refresh', async () => {
    let resolveRefresh!: () => void
    mocks.refreshAuth.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
    )
    mocks.rpc.mockResolvedValueOnce({ status: 'reconnect-required' }).mockResolvedValueOnce({
      status: 'ok',
      value: { artifacts: [artifactListItem('Account B', 'account-b')] }
    })
    const view = render(<ArtifactsPage />)
    await waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledOnce())

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    view.rerender(<ArtifactsPage />)
    expect(await screen.findByRole('button', { name: /Account B/ })).toBeInTheDocument()
    await act(async () => {
      resolveRefresh()
    })

    await waitFor(() =>
      expect(screen.queryByText('Sign in to Orca again to load artifacts.')).not.toBeInTheDocument()
    )
  })

  it('does not surface a load-more auth error after switching accounts during refresh', async () => {
    let resolveRefresh!: () => void
    mocks.refreshAuth.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
    )
    mocks.rpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          artifacts: [artifactListItem('Account A', 'account-a')],
          nextCursor: 'account-a-next'
        }
      })
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce({
        status: 'ok',
        value: { artifacts: [artifactListItem('Account B', 'account-b')] }
      })
    const view = render(<ArtifactsPage />)
    await screen.findAllByText('Account A')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledOnce())

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    view.rerender(<ArtifactsPage />)
    expect(await screen.findByRole('button', { name: /Account B/ })).toBeInTheDocument()
    await act(async () => {
      resolveRefresh()
    })

    await waitFor(() =>
      expect(screen.queryByText('Sign in to Orca again to load artifacts.')).not.toBeInTheDocument()
    )
  })

  it('never renders artifacts loaded for a previous account', async () => {
    let resolveFirst!: (value: unknown) => void
    mocks.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    const view = render(<ArtifactsPage />)

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    mocks.rpc.mockResolvedValueOnce({ status: 'ok', value: { artifacts: [] } })
    view.rerender(<ArtifactsPage />)
    await act(async () => {
      resolveFirst({
        status: 'ok',
        value: {
          artifacts: [
            {
              artifact: {
                byteSize: 1,
                createdAt: '2026-08-01T12:00:00.000Z',
                deletedAt: null,
                expiresAt: '2026-09-01T12:00:00.000Z',
                originalFileName: 'account-a-secret.html',
                renderedContentType: 'text/html',
                slug: 'account-a-secret',
                sourceContentType: 'text/html',
                title: 'Account A secret',
                updatedAt: '2026-08-02T12:00:00.000Z',
                version: 1
              },
              shareUrl: 'https://share.onorca.dev/a/account-a-secret'
            }
          ]
        }
      })
    })

    await screen.findByText('No shared artifacts')
    expect(screen.queryByText('Account A secret')).not.toBeInTheDocument()
  })

  it('does not apply a completed deletion to a new account', async () => {
    let resolveDelete!: (value: unknown) => void
    mocks.confirm.mockResolvedValue(true)
    mocks.rpc.mockResolvedValueOnce({
      status: 'ok',
      value: { artifacts: [artifactListItem('Shared slug A', 'shared-slug')] }
    })
    mocks.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )
    const view = render(<ArtifactsPage />)

    await screen.findAllByText('Shared slug A')
    await deleteFirstArtifactFromDrawerMenu()
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    mocks.rpc.mockResolvedValueOnce({
      status: 'ok',
      value: { artifacts: [artifactListItem('Shared slug B', 'shared-slug')] }
    })
    view.rerender(<ArtifactsPage />)
    await act(async () => {
      resolveDelete({ status: 'ok', value: undefined })
    })

    expect(await screen.findByRole('button', { name: /Shared slug B/ })).toBeInTheDocument()
  })

  it('does not resurrect a deletion from an older refresh', async () => {
    let resolveRefresh!: (value: unknown) => void
    mocks.confirm.mockResolvedValue(true)
    mocks.rpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: { artifacts: [artifactListItem('Delete me', 'delete-me')] }
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
      )
      .mockResolvedValueOnce({ status: 'ok', value: undefined })
    render(<ArtifactsPage />)

    await screen.findAllByText('Delete me')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await deleteFirstArtifactFromDrawerMenu()
    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument())
    await act(async () => {
      resolveRefresh({
        status: 'ok',
        value: { artifacts: [artifactListItem('Delete me', 'delete-me')] }
      })
    })

    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument())
  })
})

/** Opens the drawer from the first rendered row, then deletes through the drawer's action menu. */
async function deleteFirstArtifactFromDrawerMenu(): Promise<void> {
  const row = document.querySelector('[data-slot="context-menu-trigger"]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Expected an artifact row')
  }
  await userEvent.click(row)
  await userEvent.click(screen.getByRole('button', { name: 'More artifact actions' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete artifact' }))
}

function artifactListItem(title: string, slug: string): Record<string, unknown> {
  return {
    artifact: {
      byteSize: 1,
      createdAt: '2026-08-01T12:00:00.000Z',
      deletedAt: null,
      expiresAt: '2026-09-01T12:00:00.000Z',
      originalFileName: `${slug}.html`,
      renderedContentType: 'text/html',
      slug,
      sourceContentType: 'text/html',
      title,
      updatedAt: '2026-08-02T12:00:00.000Z',
      version: 1
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`
  }
}
