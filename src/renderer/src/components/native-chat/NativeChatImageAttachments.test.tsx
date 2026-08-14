// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFileFromState: vi.fn(),
  sources: new Map<string, string>(),
  useLocalImageSrc: vi.fn()
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  releaseLocalImageSrc: vi.fn(),
  useLocalImageSrc: (...args: unknown[]) => mocks.useLocalImageSrc(...args)
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: (...args: unknown[]) =>
    mocks.getConnectionIdForFileFromState(...args)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../image-preview/ImagePreviewDialog', () => ({
  ImagePreviewDialog: ({
    preview
  }: {
    preview: {
      fileName: string
      onDownload: () => void
      onNext?: () => void
    } | null
  }) =>
    preview ? (
      <div data-testid="viewer">
        {preview.fileName}
        <button onClick={preview.onDownload}>Download current</button>
        {preview.onNext ? <button onClick={preview.onNext}>Next current</button> : null}
      </div>
    ) : null
}))

import { NativeChatImageAttachments } from './NativeChatImageAttachments'

describe('NativeChatImageAttachments', () => {
  beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    mocks.sources.clear()
    mocks.getConnectionIdForFileFromState.mockReset()
    mocks.useLocalImageSrc.mockReset()
    vi.restoreAllMocks()
  })

  it('loads through the owning host, opens the shared viewer, and navigates resolved images', async () => {
    mocks.sources.set('/remote/one.png', 'blob:one')
    mocks.sources.set('/remote/two.png', 'blob:two')
    mocks.useLocalImageSrc.mockImplementation((path: string) => mocks.sources.get(path))
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const runtimeContext = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'worktree-1',
      worktreePath: '/remote'
    }
    render(
      <NativeChatImageAttachments
        images={[
          { id: 'one', fileName: 'one.png', path: '/remote/one.png' },
          { id: 'two', fileName: 'two.png', path: '/remote/two.png' }
        ]}
        loadContext={{ connectionId: 'ssh-1', runtimeContext }}
      />
    )

    const first = await screen.findByRole('button', { name: 'one.png' })
    fireEvent.click(first)
    expect(screen.getByTestId('viewer').textContent).toContain('one.png')
    fireEvent.click(screen.getByRole('button', { name: 'Next current' }))
    expect(screen.getByTestId('viewer').textContent).toContain('two.png')
    fireEvent.click(screen.getByRole('button', { name: 'Download current' }))

    expect(anchorClick).toHaveBeenCalledOnce()
    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(
      '/remote/one.png',
      '/remote/one.png',
      'ssh-1',
      runtimeContext
    )
  })

  it('leaves a failed image inert without opening or breaking the message', async () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    render(
      <NativeChatImageAttachments
        images={[{ id: 'missing', fileName: 'missing.png', path: '/missing.png' }]}
      />
    )

    const thumbnail = screen.getByRole('button', { name: 'missing.png' })
    expect((thumbnail as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(thumbnail)
    await waitFor(() => expect(screen.queryByTestId('viewer')).toBeNull())
  })

  it('resolves a folder-workspace image against the concrete file owner', () => {
    mocks.getConnectionIdForFileFromState.mockReturnValue('folder-ssh')
    mocks.useLocalImageSrc.mockReturnValue('blob:folder')
    const runtimeContext = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'folder:workspace-1',
      worktreePath: '/workspace'
    }
    render(
      <NativeChatImageAttachments
        images={[{ id: 'nested', fileName: 'nested.png', path: '/workspace/repo/nested.png' }]}
        loadContext={{ runtimeContext }}
      />
    )

    expect(mocks.getConnectionIdForFileFromState).toHaveBeenCalledWith(
      expect.anything(),
      'folder:workspace-1',
      '/workspace/repo/nested.png'
    )
    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(
      '/workspace/repo/nested.png',
      '/workspace/repo/nested.png',
      'folder-ssh',
      runtimeContext
    )
  })
})
