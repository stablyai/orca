import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { shouldShowNativeChatTypingIndicator } from './native-chat-typing-indicator'

function message(id: string, role: NativeChatMessage['role'], text = id): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('shouldShowNativeChatTypingIndicator', () => {
  it('stays hidden when the session is idle', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user')],
        isWorking: false
      })
    ).toBe(false)
  })

  it('shows once a send lands and no assistant row exists yet', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('a0', 'assistant'), message('u1', 'user')],
        isWorking: true
      })
    ).toBe(true)
  })

  it('hides as soon as the structured reply row arrives, before working clears', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message('orca-item', 'assistant')],
        isWorking: true
      })
    ).toBe(false)
  })

  it('hides behind the PTY streaming bubble', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message(NATIVE_CHAT_STREAMING_ID, 'assistant')],
        isWorking: true
      })
    ).toBe(false)
  })

  it('does not flicker back on when a system row interleaves mid-turn', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [
          message('u1', 'user'),
          message('a1', 'assistant'),
          message('s1', 'system', 'Ran /status')
        ],
        isWorking: true
      })
    ).toBe(false)
  })

  it('shows again for the next send even though an earlier turn replied', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user')],
        isWorking: true
      })
    ).toBe(true)
  })

  it('shows after a slash-command marker even though an earlier turn replied', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [
          message('a1', 'assistant'),
          message('command:compact', 'system', 'Ran /compact')
        ],
        isWorking: true
      })
    ).toBe(true)
  })

  it('shows on a session whose transcript is still empty', () => {
    expect(shouldShowNativeChatTypingIndicator({ messages: [], isWorking: true })).toBe(true)
  })
})

// These build rows through the REAL structured projection instead of hand-made
// `command:` marker ids. The hand-made ids only exist on the PTY transport, so
// tests using them were blind to how the shipping transport actually looks.
describe('with rows projected from the structured journal', () => {
  function toolCallItem(sequence: number): AgentJournalRenderItem {
    return {
      itemId: `codex:thread-1:turn-1:${sequence}`,
      revision: 1,
      sequence,
      observedAt: 1_800_000_000_000,
      body: {
        kind: 'tool-call',
        name: 'shell',
        state: 'running',
        input: { command: 'sed -n 1,240p README.md' }
      }
    } as AgentJournalRenderItem
  }

  function assistantTextItem(sequence: number): AgentJournalRenderItem {
    return {
      itemId: `codex:thread-1:turn-1:${sequence}`,
      revision: 1,
      sequence,
      observedAt: 1_800_000_000_000,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: "I'm checking PR 14696's metadata." }]
      }
    } as AgentJournalRenderItem
  }

  it('keeps showing while a running command is the newest row', () => {
    // The screenshot case: prose landed, then codex started running shell commands
    // and the chat body went still for the length of the command.
    const messages = projectStructuredItemsToNativeChat([assistantTextItem(1), toolCallItem(2)])
    expect(messages.at(-1)?.role).toBe('assistant')
    expect(shouldShowNativeChatTypingIndicator({ messages, isWorking: true })).toBe(true)
  })

  it('still hides once prose is the newest row', () => {
    const messages = projectStructuredItemsToNativeChat([toolCallItem(1), assistantTextItem(2)])
    expect(shouldShowNativeChatTypingIndicator({ messages, isWorking: true })).toBe(false)
  })

  it('stays hidden when the turn is not working, command row or not', () => {
    const messages = projectStructuredItemsToNativeChat([toolCallItem(1)])
    expect(shouldShowNativeChatTypingIndicator({ messages, isWorking: false })).toBe(false)
  })
})
