// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachments,
  settleNativeChatPendingAttachment,
  settleNativeChatPendingAttachmentReferences
} from './native-chat-pending-attachment-cache'
import {
  holdNativeChatPendingImageSave,
  releaseNativeChatPendingImageSave
} from './native-chat-pending-attachment-scopes'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'

// Data loss guard: a composer going unavailable must not drop an image main is still saving,
// nor the finished image queued behind it, so both reach the draft in paste order.
it('keeps a saving image and its queued successor when the composer goes unavailable', () => {
  const scope = 'pending-cache-invariant'
  addNativeChatPendingAttachment(scope, { id: 'first', path: '', pending: true })
  addNativeChatPendingAttachment(scope, { id: 'second', path: '', pending: true })
  holdNativeChatPendingImageSave('first')
  expect(settleNativeChatPendingAttachment(scope, 'second', '/tmp/second.png')).toBe(true)

  clearNativeChatPendingAttachments(scope, { keepSaving: true })

  expect(settleNativeChatPendingAttachment(scope, 'first', '/tmp/first.png')).toBe(true)
  releaseNativeChatPendingImageSave('first')
  expect(readNativeChatComposerDraft(scope).images.map(({ path }) => path)).toEqual([
    '/tmp/first.png',
    '/tmp/second.png'
  ])
})

// A composer that takes file references gets them in paste order even when saves finish out of order.
it('inserts saved file references in paste order when the later save finishes first', () => {
  const scope = 'pending-reference-order-invariant'
  addNativeChatPendingAttachment(scope, { id: 'early', path: '', pending: true })
  addNativeChatPendingAttachment(scope, { id: 'late', path: '', pending: true })

  expect(
    settleNativeChatPendingAttachmentReferences(scope, [{ id: 'late', path: '/tmp/late.png' }])
  ).toBe(true)
  expect(readNativeChatComposerDraft(scope).text).toBe('')
  settleNativeChatPendingAttachmentReferences(scope, [{ id: 'early', path: '/tmp/early.png' }])

  expect(readNativeChatComposerDraft(scope).text).toBe('@/tmp/early.png @/tmp/late.png')
})
