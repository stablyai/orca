// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageActions, ImageActionsButton } from './ImageActions'
import { PanZoomImageDialog } from './PanZoomImageDialog'

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), copy: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('@/lib/clipboard-image-copy', () => ({ copyImageToClipboard: mocks.copy }))
const writeClipboardText = vi.fn()
const openPath = vi.fn()
const openInFileManager = vi.fn()
const saveDownloadedFile = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  writeClipboardText.mockResolvedValue(undefined)
  mocks.copy.mockResolvedValue(undefined)
  openPath.mockResolvedValue(undefined)
  openInFileManager.mockResolvedValue({ ok: true })
  saveDownloadedFile.mockResolvedValue({ canceled: true })
  vi.stubGlobal('api', {
    ui: { writeClipboardText },
    shell: { openPath, openInFileManager },
    fs: { saveDownloadedFile }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['original'], { type: 'image/webp' })
    })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function names(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

describe('image action menus', () => {
  it('does not show an empty menu for a web client without desktop image operations', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    render(<ImageActionsButton src="blob:internal" title="Photo" />)
    expect(screen.queryByRole('button', { name: 'Image actions' })).toBeNull()
  })
  it('disables copy and save from both menus after the preview fails', async () => {
    render(
      <PanZoomImageDialog
        open
        onOpenChange={() => {}}
        src="blob:broken"
        title="broken.png"
        fallback={<span>Preview unavailable</span>}
      />
    )
    fireEvent.error(screen.getByRole('img'))
    fireEvent.contextMenu(screen.getByText('Preview unavailable'))
    expect(screen.getByRole('menuitem', { name: 'Copy image' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: 'Save image as…' })).toHaveAttribute(
      'data-disabled'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('offers all five local-file actions from right click and routes OS opens with ownership', async () => {
    render(
      <ImageActions
        src="blob:original"
        title="photo.webp"
        imageSource={{ path: '/shots/photo.webp', localOwner: 'local' }}
      >
        <button>Photo</button>
      </ImageActions>
    )
    const open = () =>
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Photo' }), {
        clientX: 30,
        clientY: 30
      })
    open()
    expect(names()).toHaveLength(5)
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy image path' }))
    )
    expect(writeClipboardText).toHaveBeenCalledWith('/shots/photo.webp')
    open()
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open with default app' }))
    )
    expect(openPath).toHaveBeenCalledWith('/shots/photo.webp', 'local')
    open()
    const reveal = screen.getAllByRole('menuitem')[3]
    await act(async () => fireEvent.click(reveal))
    expect(openInFileManager).toHaveBeenCalledWith('/shots/photo.webp', 'local')
  })

  it.each([undefined, 'unresolved', 'runtime:server', 'ssh:host'] as const)(
    'never offers local OS actions for owner %s',
    async (localOwner) => {
      render(
        <ImageActionsButton
          src="blob:remote"
          title="photo.webp"
          imageSource={{ path: '/remote/photo.webp', localOwner }}
        />
      )
      await userEvent.click(screen.getByRole('button', { name: 'Image actions' }))
      expect(names()).toEqual(['Copy image', 'Save image as…', 'Copy image path'])
    }
  )

  it('copies a real network URL, while blob sources have no copy-link item', async () => {
    const { rerender } = render(
      <ImageActionsButton src="https://example.com/photo.webp" title="Photo" />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Image actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy image link' }))
    expect(writeClipboardText).toHaveBeenCalledWith('https://example.com/photo.webp')
    rerender(<ImageActionsButton src="blob:internal" title="Photo" />)
    await userEvent.click(screen.getByRole('button', { name: 'Image actions' }))
    expect(names()).toEqual(['Copy image', 'Save image as…'])
  })

  it('keeps the preview open when copying, and treats save cancellation quietly', async () => {
    const onOpenChange = vi.fn()
    render(
      <PanZoomImageDialog open onOpenChange={onOpenChange} src="blob:original" title="photo.webp" />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Image actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy image' }))
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    mocks.success.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Image actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save image as…' }))
    await waitFor(() => expect(saveDownloadedFile).toHaveBeenCalledOnce())
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
