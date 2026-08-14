// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { copyMarkdownDocument } from './markdown-header-copy'

describe('copyMarkdownDocument', () => {
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = { ui: { writeClipboardText } }
  })

  it('writes the markdown source and reports success', async () => {
    writeClipboardText.mockResolvedValue(undefined)

    await expect(copyMarkdownDocument('# Hello')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('# Hello')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('toasts and reports failure when the clipboard write rejects', async () => {
    writeClipboardText.mockRejectedValue(new Error('clipboard unavailable'))

    await expect(copyMarkdownDocument('# Hello')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith('Failed to copy markdown')
  })
})
