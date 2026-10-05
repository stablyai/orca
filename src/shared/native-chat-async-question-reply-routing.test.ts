// The async-question reply must reach the agent as a message on every send seam: no
// slash/command classifier may read it as a command, whatever the question's title is.

import { describe, expect, it } from 'vitest'
import { formatAsyncQuestionReply } from './native-chat-async-questions'
import {
  classifyNativeChatSend,
  getAgentSlashCommands,
  isSlashCommandDraft
} from './native-chat-slash-commands'
import { isStructuredAgentSessionComposerCommand } from './structured-agent-session-composer'

const titles = ['/model', '/compact', '$skill', '/goal ship it', 'Which model?']

describe('formatted async-question replies', () => {
  it.each(titles)('are never a command for title %s', (title) => {
    const reply = formatAsyncQuestionReply([{ title, answer: 'gpt-5' }])
    expect(reply.startsWith('Question: ')).toBe(true)
    expect(isSlashCommandDraft(reply)).toBe(false)
    for (const agent of ['claude', 'codex'] as const) {
      // Terminal seams (desktop composer core and phone answerQuestion) classify with this.
      expect(classifyNativeChatSend(reply, getAgentSlashCommands(agent), null, '$')).toBe('chat')
      // The structured phone send intercepts host commands with this.
      expect(isStructuredAgentSessionComposerCommand(reply, agent)).toBe(false)
    }
  })
})
