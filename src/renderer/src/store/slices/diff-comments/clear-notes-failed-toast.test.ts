import { beforeEach, describe, expect, it, vi } from 'vitest'

const { error, dismiss } = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error, dismiss } }))

import { dismissClearNotesFailedToast, showClearNotesFailedToast } from './clear-notes-failed-toast'

describe('clear notes failure toast', () => {
  beforeEach(() => {
    error.mockClear()
    dismiss.mockClear()
  })

  it('reuses one toast for repeat failures and takes it down on success', () => {
    showClearNotesFailedToast()
    showClearNotesFailedToast()
    expect(error).toHaveBeenCalledTimes(2)
    const ids = error.mock.calls.map((call) => call[1]?.id)
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBe(ids[0])

    dismissClearNotesFailedToast()
    expect(dismiss).toHaveBeenCalledWith(ids[0])
  })
})
