import { describe, expect, it } from 'vitest'
import { isEmptyNativeChatDraft, parseNativeChatDraft } from './native-chat-draft-record'

describe("a saved draft's held sends", () => {
  it('keeps each one with its id, text, images and time, ignoring fields a newer build added', () => {
    expect(
      parseNativeChatDraft({
        text: '',
        attachments: [],
        heldSends: [
          {
            clientMessageId: 'm1',
            text: 'sent once',
            attachments: [{ id: 'a1', path: '/a.png', location: 'local' }],
            sentAt: 5,
            fromNewerBuild: true
          }
        ]
      })
    ).toEqual({
      text: '',
      attachments: [],
      heldSends: [
        {
          clientMessageId: 'm1',
          text: 'sent once',
          attachments: [{ id: 'a1', path: '/a.png', location: 'local' }],
          sentAt: 5
        }
      ]
    })
  })

  it('drops an entry with no id or no text, and keeps the draft only while something is left', () => {
    expect(
      parseNativeChatDraft({
        text: '',
        attachments: [],
        heldSends: [{ text: 'no id' }, { clientMessageId: 'm2' }, 'junk']
      })
    ).toBeNull()
  })

  it('counts a box emptied by a send that is still held as worth saving', () => {
    expect(
      isEmptyNativeChatDraft({
        text: '',
        attachments: [],
        heldSends: [{ clientMessageId: 'm1', text: 'sent once', attachments: [], sentAt: 5 }]
      })
    ).toBe(false)
  })
})
