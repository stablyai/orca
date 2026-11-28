import { TERMINAL_RUNTIME_CAPABILITIES } from '../terminal/runtime-policy/terminal-runtime-capabilities'
import { expect, it } from 'vitest'
import {
  assertNotificationReplyTerminalSupport,
  notificationReplyTerminalClient
} from '../../../mobile/src/notifications/reply/notification-reply-terminal-input'
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

it('refuses peers that have not advertised the commit-time composer guard', () => {
  for (const capabilities of [undefined, [], ['terminal.send-approval-guard.v1']]) {
    expect(() => assertNotificationReplyTerminalSupport(capabilities)).toThrow(
      'does not support safe notification replies'
    )
  }
  expect(() => assertNotificationReplyTerminalSupport(TERMINAL_RUNTIME_CAPABILITIES)).not.toThrow()
})
