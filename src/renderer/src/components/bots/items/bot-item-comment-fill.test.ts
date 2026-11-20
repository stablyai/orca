// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'
import { fillBotItemCommentDraft, restoreBotItemCommentDraft } from './bot-item-comment-fill'

it('sets aside what the box held, so no image of it goes with the answer, and brings it back after the send', () => {
  const box = 'bot-item-comment:test:uid-fill'
  const wip = {
    text: 'third answer, half typed',
    document: undefined,
    images: [{ id: 'q3', path: '/q3.png' }]
  }
  updateNativeChatComposerDraft(box, wip, 'immediate')

  fillBotItemCommentDraft(box, 'first answer', [])

  expect(readNativeChatComposerDraft(box)).toMatchObject({ text: 'first answer ', images: [] })
  updateNativeChatComposerDraft(box, { text: '', document: undefined, images: [] }, 'immediate')
  restoreBotItemCommentDraft(box)
  expect(readNativeChatComposerDraft(box)).toMatchObject({
    text: 'third answer, half typed',
    images: [{ path: '/q3.png' }]
  })
})
