import { expect, it } from 'vitest'
import { readNotificationReplyDraftRecord } from '../../../mobile/src/notifications/reply/notification-reply-draft-record'

it('ignores corrupt failed-reply records without blocking notification navigation', () => {
  for (const raw of [
    '{broken',
    'null',
    '42',
    '{"text":7}',
    '{"text":"sent already","restored":true}'
  ]) {
    expect(readNotificationReplyDraftRecord(raw)).toBeNull()
  }
  expect(readNotificationReplyDraftRecord('{"text":"keep this reply","state":"failed"}')).toEqual({
    text: 'keep this reply',
    state: 'failed'
  })
})
