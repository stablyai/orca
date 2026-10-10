import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  openBrowserProfileTabInActiveWorkspace: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openBrowserProfileTabInActiveWorkspace: mocks.openBrowserProfileTabInActiveWorkspace
    })
  }
}))

import { subscribeDocPreviewExternalLinkConfirmation } from './doc-preview-external-link-confirmation'

function installSubscription(confirm: ConfirmationDialogContextValue): (url: string) => void {
  let listener: ((payload: { url: string }) => void) | null = null
  vi.stubGlobal('window', {
    api: {
      docPreview: {
        onExternalLink: (callback: (payload: { url: string }) => void): (() => void) => {
          listener = callback
          return () => {}
        }
      }
    }
  })
  subscribeDocPreviewExternalLinkConfirmation(confirm)
  if (!listener) {
    throw new Error('external-link confirmation did not subscribe')
  }
  return (url) => listener?.({ url })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openBrowserProfileTabInActiveWorkspace.mockResolvedValue(true)
})

describe('document preview external-link confirmation', () => {
  it('shows the exact destination and opens only after confirmation', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    const emit = installSubscription(confirm)

    emit('https://example.com/docs?source=preview')

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open link to example.com?',
        description: 'https://example.com/docs?source=preview'
      })
    )
    await vi.waitFor(() =>
      expect(mocks.openBrowserProfileTabInActiveWorkspace).toHaveBeenCalledWith(
        'https://example.com/docs?source=preview',
        null
      )
    )
  })

  it('opens nothing when the reader cancels', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)
    const emit = installSubscription(confirm)

    emit('https://example.com/docs')

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(mocks.openBrowserProfileTabInActiveWorkspace).not.toHaveBeenCalled()
  })

  it('surfaces a confirmed link that the browser refuses', async () => {
    mocks.openBrowserProfileTabInActiveWorkspace.mockResolvedValue(false)
    const emit = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )

    emit('https://example.com/docs')

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
  })
})
