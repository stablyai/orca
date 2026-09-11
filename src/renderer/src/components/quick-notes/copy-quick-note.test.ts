// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyQuickNoteToClipboard } from './copy-quick-note'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const success = vi.fn()
const error = vi.fn()

vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = { ui: { writeClipboardText } }
})

describe('copyQuickNoteToClipboard', () => {
  it('writes the note body to the clipboard and toasts success', async () => {
    writeClipboardText.mockResolvedValue()
    const ok = await copyQuickNoteToClipboard({ id: 'n1', label: 'Sig', body: 'line 1\nline 2' })
    expect(ok).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('line 1\nline 2')
    expect(success).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })

  it('toasts an error and returns false when the clipboard write rejects', async () => {
    writeClipboardText.mockRejectedValue(new Error('unfocused'))
    const ok = await copyQuickNoteToClipboard({ id: 'n1', label: 'Sig', body: 'x' })
    expect(ok).toBe(false)
    expect(error).toHaveBeenCalledOnce()
  })
})
