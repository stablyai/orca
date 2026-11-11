import { describe, expect, it } from 'vitest'
import { isNoiseMessage } from './native-chat-noise'
import type { NativeChatMessage } from './native-chat-types'

function msg(
  role: NativeChatMessage['role'],
  text: string,
  blocks?: NativeChatMessage['blocks']
): NativeChatMessage {
  return {
    id: text.slice(0, 8),
    role,
    blocks: blocks ?? [{ type: 'text', text }],
    timestamp: 0,
    source: 'transcript'
  }
}

describe('isNoiseMessage', () => {
  it('keeps real user messages', () => {
    expect(isNoiseMessage(msg('user', 'make it work for codex'))).toBe(false)
    expect(isNoiseMessage(msg('user', '<bash-brothers> is my band'))).toBe(false)
  })

  it('keeps assistant, tool, and ordinary system turns', () => {
    expect(isNoiseMessage(msg('assistant', '<system-reminder> in prose'))).toBe(false)
    expect(isNoiseMessage(msg('tool', '<system-reminder> in prose'))).toBe(false)
    expect(isNoiseMessage(msg('system', 'Conversation interrupted'))).toBe(false)
  })

  it('keeps tool-bearing user turns even when their text looks like harness noise', () => {
    for (const block of [
      { type: 'tool-result', output: 'ok' },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } }
    ] satisfies NativeChatMessage['blocks']) {
      expect(
        isNoiseMessage(msg('user', '', [{ type: 'text', text: '<task-notification>done' }, block]))
      ).toBe(false)
    }
  })
})
