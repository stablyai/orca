import { expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
vi.mock('./GrabConfirmationSheet', () => ({ formatGrabPayloadAsText: () => 'text' }))

const { copyGrabPayloadText } = await import('./grab-text-copy')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the formatter is mocked; the payload is only passed through.
const payload = { page: {} } as unknown as BrowserGrabPayload

it("says Copied only once the clipboard took the text, and Couldn't copy when it refused", async () => {
  let finish: (ok: boolean) => void = () => {}
  vi.stubGlobal('window', {
    api: {
      ui: {
        writeClipboardText: () =>
          new Promise<void>((resolve, reject) => {
            finish = (ok) => (ok ? resolve() : reject(new Error('denied')))
          })
      }
    }
  })
  const toast = vi.fn()
  copyGrabPayloadText(payload, toast, 'Copied')
  await Promise.resolve()
  expect(toast).not.toHaveBeenCalled()
  finish(true)
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Copied', 'success', payload, true))

  toast.mockClear()
  copyGrabPayloadText(payload, toast, 'Copied')
  finish(false)
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't copy", 'error', payload))
  vi.unstubAllGlobals()
})
