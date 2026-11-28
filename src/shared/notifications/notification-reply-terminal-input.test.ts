import { expect, it } from 'vitest'
import { notificationReplyInputIsEmpty } from '../../../mobile/src/notifications/reply/notification-reply-terminal-input'
import { terminalComposerDraftSchema } from '../../../mobile/src/terminal/host-operations/terminal-reply-schema'

it('accepts an omitted empty composer draft while protecting existing text and missing snapshots', () => {
  expect(
    notificationReplyInputIsEmpty(
      terminalComposerDraftSchema.parse({ terminal: { handle: 'terminal-1' } }).terminal
    )
  ).toBe(true)
  expect(
    notificationReplyInputIsEmpty(
      terminalComposerDraftSchema.parse({ terminal: { draft: '' } }).terminal
    )
  ).toBe(true)
  expect(
    notificationReplyInputIsEmpty(
      terminalComposerDraftSchema.parse({ terminal: { draft: 'already typing' } }).terminal
    )
  ).toBe(false)
  expect(notificationReplyInputIsEmpty(terminalComposerDraftSchema.parse({}).terminal)).toBe(false)
})
