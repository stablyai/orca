import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestEditorFileSave, toastError } = vi.hoisted(() => ({
  requestEditorFileSave: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('./editor-autosave', () => ({ requestEditorFileSave }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
// Return the English fallback so the assertion is stable without initializing i18n.
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { attemptEditorFileSave } from './editor-file-save-attempt'

describe('attemptEditorFileSave', () => {
  beforeEach(() => {
    requestEditorFileSave.mockReset()
    toastError.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces a failed save and reports failure to dependent actions (STA-2027)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('disk full')
    requestEditorFileSave.mockRejectedValue(cause)

    await expect(attemptEditorFileSave({ fileId: 'file-1' })).resolves.toBe(false)

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Failed to save the file. Please try again.')
    expect(consoleError).toHaveBeenCalledWith('[editor] file save failed', cause)
  })
})
