// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ImageBlobPng from '@/lib/image-blob-png'

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), writeClipboardImage: vi.fn() }))

vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('@/lib/image-blob-png', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBlobPng>()),
  convertImageBlobToPng: async (blob: Blob) => blob
}))

const { copyNativeChatImage } = await import('./native-chat-image-copy')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

beforeEach(() => {
  vi.stubGlobal('api', { ui: { writeClipboardImage: mocks.writeClipboardImage } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('copyNativeChatImage', () => {
  it('explains a too-large refusal that arrives through the IPC error prefix', async () => {
    mocks.writeClipboardImage.mockRejectedValue(
      new Error(
        "Error invoking remote method 'clipboard:writeImage': Error: Clipboard image is too large"
      )
    )

    await copyNativeChatImage(async () => new Blob([PNG], { type: 'image/png' }))

    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith("Couldn't copy image", {
      description: 'The image is too large to copy.'
    })
  })
})
