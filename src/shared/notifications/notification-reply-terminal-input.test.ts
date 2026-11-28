import { expect, it } from 'vitest'
import { notificationReplyTerminalClient } from '../../../mobile/src/notifications/reply/notification-reply-terminal-input'
import {
  terminalInputSourceForClient,
  resolveMobileFloorClientId
} from '../../main/runtime/rpc/methods/terminal/terminal-input-delivery'
it('admits the paired headless reply as programmatic input without claiming a mobile subscriber', () => {
  const client = notificationReplyTerminalClient()
  expect(
    terminalInputSourceForClient(client, { kind: 'paired-device', deviceId: 'paired-phone' })
  ).toBe('programmatic')
  expect(resolveMobileFloorClientId(null, client)).toBeNull()
  expect(terminalInputSourceForClient(client)).toBe('desktop')
})
