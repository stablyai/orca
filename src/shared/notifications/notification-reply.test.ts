import { describe, expect, it } from 'vitest'
import { notificationReplyFields, readNotificationReplyTarget } from './notification-reply'
import { readOrcaPushPayload } from '../../../mobile/src/notifications/payload-identity/push-payload'

describe('notification reply target decoding', () => {
  it('keeps the original alert when reply fields would exceed the gateway payload budget', () => {
    const target = { type: 'chat', sessionId: 'chat-42' } as const
    expect(notificationReplyFields({ body: 'x'.repeat(2990) }, target)).toEqual({})
    // The soundless delivery variant adds 14 bytes after reply enrichment.
    expect(notificationReplyFields({ body: 'x'.repeat(2907) }, target)).toEqual({})
    expect(notificationReplyFields({ body: 'Finished' }, target)).toEqual({
      category: 'orca.reply',
      replyTarget: { type: 'chat', sessionId: 'chat-42' }
    })
  })
  it('keeps the same exact target through APNs objects and string-valued FCM data', () => {
    for (const target of [
      { type: 'terminal', terminal: 'terminal-17', expectedIncarnationId: 'process-23' },
      { type: 'chat', sessionId: 'chat-42' },
      { type: 'bot-item', itemUid: 'item-11' },
      { type: 'group', groupId: 'group-7' }
    ]) {
      expect(
        readOrcaPushPayload({ orca: { hostFingerprint: 'paired-host-key1', replyTarget: target } })
          ?.replyTarget
      ).toEqual(target)
      expect(
        readOrcaPushPayload({
          hostFingerprint: 'paired-host-key1',
          replyTarget: JSON.stringify(target)
        })?.replyTarget
      ).toEqual(target)
    }
  })

  it('refuses unfenced terminals, malformed targets and injected credentials', () => {
    for (const target of [
      { type: 'terminal', terminal: 'terminal-17' },
      { type: 'chat', sessionId: '' },
      { type: 'chat', sessionId: 'chat-42', deviceToken: 'injected' },
      { type: 'bot-item', itemUid: '' },
      { type: 'shell', command: 'echo unsafe' },
      '{broken',
      null
    ]) {
      expect(readNotificationReplyTarget(target)).toBeNull()
    }
  })
})
