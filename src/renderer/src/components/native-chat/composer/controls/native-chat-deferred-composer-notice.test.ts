// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  closeNativeChatComposerNoticeRoute,
  deferNativeChatComposerNotice,
  openNativeChatComposerNoticeRoute,
  takeDeferredNativeChatComposerNotices
} from './native-chat-deferred-composer-notice'
import { moveNativeChatPendingAttachments } from '../../attachments/chips/native-chat-pending-attachment-cache'
import { deleteNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-removal'

// A failure reported before its draft moves is published where the draft went; once the draft is
// deleted for good, neither a waiting nor a late notice survives it.
it('routes a reported paste failure with its moving draft and retires it with a deleted one', () => {
  const moved = openNativeChatComposerNoticeRoute('notice-route-source')
  moveNativeChatPendingAttachments('notice-route-source', 'notice-route-destination')
  expect(closeNativeChatComposerNoticeRoute(moved)).toBe('notice-route-destination')

  const late = openNativeChatComposerNoticeRoute('notice-route-destination')
  deferNativeChatComposerNotice('notice-route-destination', 'Image paste failed.')
  deleteNativeChatComposerDraft('notice-route-destination')

  expect(closeNativeChatComposerNoticeRoute(late)).toBeNull()
  const shown: string[] = []
  takeDeferredNativeChatComposerNotices('notice-route-destination', ({ text }) =>
    shown.push(text)
  )()
  expect(shown).toEqual([])
})
