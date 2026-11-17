// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderProbe, unmountPasteProbe } from './native-chat-composer-paste-test-fixtures'

async function pasteImage(): Promise<{ image: File; save: ReturnType<typeof vi.fn> }> {
  const save = vi.fn().mockResolvedValue('/tmp/pasted.png')
  vi.stubGlobal('api', { ui: { saveClipboardImageAsTempFile: save } })
  const probe = await renderProbe({ resolveAttachmentOwner: () => ({ kind: 'local' }) })
  const image = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
  const clipboardData = new DataTransfer()
  clipboardData.items.add(image)
  await act(async () => {
    probe.latest().handlePaste({ clipboardData, defaultPrevented: false, preventDefault: () => {} })
  })
  return { image, save }
}

afterEach(() => {
  unmountPasteProbe()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
})

// Insecure origins (plain HTTP) have no async clipboard, so the event's image is the only copy.
it('saves the paste event image in the web client', async () => {
  Reflect.set(window, '__ORCA_WEB_CLIENT__', true)
  const { image, save } = await pasteImage()
  expect(save).toHaveBeenCalledWith({ forNativeChatDraft: true, eventImage: image })
})

it('keeps the Blob out of desktop IPC, which cannot clone it', async () => {
  const { save } = await pasteImage()
  expect(save).toHaveBeenCalledWith({ forNativeChatDraft: true })
})
