import { beforeEach, describe, expect, it, vi } from 'vitest'

const { error, dismiss } = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error, dismiss } }))

import { dismissClearNotesFailedToast, showClearNotesFailedToast } from './clear-notes-failed-toast'
import {
  dismissSentNotesStillListedToast,
  showSentNotesStillListedToast
} from './sent-notes-still-listed-toast'

describe('sent notes still listed toast', () => {
  beforeEach(() => {
    error.mockClear()
    dismiss.mockClear()
  })

  it('offers Remove and never shares an id with the Clear failure', () => {
    const remove = vi.fn()
    showSentNotesStillListedToast(remove)
    showClearNotesFailedToast()
    const [sent, cleared] = error.mock.calls
    expect(sent[0]).toBe("Notes sent, but they're still in the list.")
    expect(sent[1].action.label).toBe('Remove')
    sent[1].action.onClick()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(sent[1].id).not.toBe(cleared[1].id)

    dismissSentNotesStillListedToast()
    dismissClearNotesFailedToast()
    expect(dismiss.mock.calls.map((call) => call[0])).toEqual([sent[1].id, cleared[1].id])
  })
})
