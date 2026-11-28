// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BotGroupRemoteAsk as RemoteAsk } from '../../../../shared/bots/bot-group'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { BotGroupRemoteAsk } from './BotGroupRemoteAsk'

afterEach(cleanup)

function answered(text: string): string {
  const ask: RemoteAsk = {
    environmentId: 'workstation',
    botId: 'builds',
    chatSessionId: 'chat-builds',
    computer: 'Workstation',
    joinedAfter: 0,
    name: 'Nightly builds',
    avatar: mascotAvatar('F1'),
    agent: 'claude',
    requestId: 'msg_000000000001',
    state: 'sent',
    reply: { kind: 'answer', text }
  }
  return render(<BotGroupRemoteAsk ask={ask} />).container.textContent ?? ''
}

it("draws a remote bot's quiet answer as the phone does, never its marker", () => {
  const note = answered('Green on main.\n\nNO_REPLY')
  expect(note).toContain('Green on main.')
  expect(note).not.toContain('NO_REPLY')
  cleanup()
  const quiet = answered('NO_REPLY')
  expect(quiet).toContain('Nothing to report')
  expect(quiet).not.toContain('NO_REPLY')
  cleanup()
  expect(answered('Green on main.')).toContain('Green on main.')
})
