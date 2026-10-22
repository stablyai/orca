import { describe, expect, it } from 'vitest'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'

const SHOT = { id: 'a-1', path: '/repo/shot.png' }
const DIAGRAM = { id: 'a-2', path: '/repo/diagram.png' }
const SENT = { text: 'abcd', images: [SHOT] }

describe('nativeChatComposerDraftLeftAfterSend', () => {
  it('leaves nothing of a draft still as sent', () => {
    expect(nativeChatComposerDraftLeftAfterSend(SENT, SENT)).toEqual({ text: '', images: [] })
  })

  it('keeps text typed after, and images attached, since the send', () => {
    expect(
      nativeChatComposerDraftLeftAfterSend({ text: 'abcd more', images: [SHOT, DIAGRAM] }, SENT)
    ).toEqual({ text: ' more', images: [DIAGRAM] })
  })

  it('keeps text composed inside the sent text, away from its end', () => {
    expect(nativeChatComposerDraftLeftAfterSend({ text: 'ab가cd', images: [] }, SENT)).toEqual({
      text: '가',
      images: []
    })
  })

  it('leaves a draft replaced or edited inside the sent text alone', () => {
    expect(nativeChatComposerDraftLeftAfterSend({ text: 'new', images: [SHOT] }, SENT)).toBeNull()
    expect(nativeChatComposerDraftLeftAfterSend({ text: 'abXd', images: [] }, SENT)).toBeNull()
  })

  it('keeps the whole text when only images were sent', () => {
    expect(
      nativeChatComposerDraftLeftAfterSend(
        { text: 'typed', images: [SHOT] },
        { text: '', images: [SHOT] }
      )
    ).toEqual({ text: 'typed', images: [] })
  })
})
