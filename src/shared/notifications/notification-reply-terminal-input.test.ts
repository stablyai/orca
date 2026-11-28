import { expect, it } from 'vitest'
import {
  notificationReplyInputIsEmpty,
  notificationReplyTerminalClient
} from '../../../mobile/src/notifications/reply/notification-reply-terminal-input'
import {
  terminalInputSourceForClient,
  resolveMobileFloorClientId
} from '../../main/runtime/rpc/methods/terminal/terminal-input-delivery'
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

it('admits the paired headless reply as programmatic input without claiming a mobile subscriber', () => {
  const client = notificationReplyTerminalClient()
  expect(
    terminalInputSourceForClient(client, { kind: 'paired-device', deviceId: 'paired-phone' })
  ).toBe('programmatic')
  expect(resolveMobileFloorClientId(null, client)).toBeNull()
  expect(terminalInputSourceForClient(client)).toBe('desktop')
})
