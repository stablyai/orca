import { expect, test } from '@playwright/test'

test('web image save rejects invalid supplied bytes and accepts a real PNG draft attachment', async ({
  page
}) => {
  await page.goto('/fixtures.html', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const apiPath = '/src/web/preload-api/web-clipboard-api.ts'
    const sessionPath = '/src/web/preload-api/web-runtime-session.ts'
    const filesPath = '/src/lib/browser-attachment-files.ts'
    const { saveWebClipboardImageAsTempFile } = await import(apiPath)
    const { webRuntimeState } = await import(sessionPath)
    const { takeBrowserAttachmentFile } = await import(filesPath)
    const previous = webRuntimeState.activeEnvironment
    webRuntimeState.activeEnvironment = { id: 'validation-fixture' }
    try {
      let rejected = false
      try {
        await saveWebClipboardImageAsTempFile({
          imageDataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl',
          forNativeChatDraft: true,
          forStructuredChat: true
        })
      } catch {
        rejected = true
      }
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const token = await saveWebClipboardImageAsTempFile({
        imageDataUrl: canvas.toDataURL('image/png'),
        forNativeChatDraft: true,
        forStructuredChat: true
      })
      const file = takeBrowserAttachmentFile(token)
      return {
        rejected,
        valid: token?.startsWith('orca-browser-file:'),
        type: file?.type,
        size: file?.size
      }
    } finally {
      webRuntimeState.activeEnvironment = previous
    }
  })
  expect(result.rejected).toBe(true)
  expect(result.valid).toBe(true)
  expect(result.type).toBe('image/png')
  expect(result.size).toBeGreaterThan(0)
})
