import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import { answerOpenForEditPrompt, askToOpenForEdit } from './perforce-open-for-edit-prompt'

const modal = vi.hoisted((): { data: Record<string, unknown> | null; opened: number } => ({
  data: null,
  opened: 0
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      // Like the store: the singleton slot settles whatever modal it replaces.
      openModal: (_modal: string, data: Record<string, unknown>) => {
        const dismissed = modal.data?.[MODAL_DISMISSED_KEY]
        modal.data = data
        modal.opened += 1
        if (typeof dismissed === 'function') {
          dismissed()
        }
      }
    })
  }
}))

beforeEach(() => {
  answerOpenForEditPrompt(false)
  modal.data = null
  modal.opened = 0
})

describe('askToOpenForEdit', () => {
  it("answers with the dialog's choice, and a second save of the file shares it", async () => {
    const first = askToOpenForEdit('a.cs')
    const second = askToOpenForEdit('a.cs')
    expect(modal.opened).toBe(1)
    answerOpenForEditPrompt(true)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('declines a prompt that another modal replaced', async () => {
    const first = askToOpenForEdit('a.cs')
    const second = askToOpenForEdit('b.cs')
    await expect(first).resolves.toBe(false)
    answerOpenForEditPrompt(true)
    await expect(second).resolves.toBe(true)
  })
})
