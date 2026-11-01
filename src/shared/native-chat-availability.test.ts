import { expect, it } from 'vitest'
import { canToggleNativeChat } from './native-chat-availability'

it('offers the old view only for supported WSL agents and always allows returning to terminal', () => {
  for (const [isWslProject, launchAgent, available] of [
    [true, 'claude', true],
    [true, 'codex', true],
    [false, 'claude', false],
    [undefined, 'claude', false],
    [true, 'openclaude', false],
    [true, 'zcode', false]
  ] as const) {
    const input = { contentType: 'terminal', isWslProject, launchAgent } as const
    expect(canToggleNativeChat(input)).toBe(available)
    expect(canToggleNativeChat({ ...input, isChatViewMode: true })).toBe(true)
  }
  expect(canToggleNativeChat({ contentType: 'terminal', isChatViewMode: true })).toBe(true)
  expect(canToggleNativeChat({ contentType: 'agent-session', isChatViewMode: true })).toBe(false)
})
