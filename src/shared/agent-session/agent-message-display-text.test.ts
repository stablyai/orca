import { expect, it, vi } from 'vitest'
import { agentMessageDisplayText, agentMessageTranscriptText } from './agent-message-display-text'
import type { AgentMessageSource } from './agent-session-message-source'
import type { NativeChatBlock } from '../native-chat-types'
import * as grammar from '../orca-dispatch-status-prompt'

const task: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
}
const prefix = `${grammar.ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\r\nInstructions\r\n=== TASK ===\r\n`

it('keeps exact task suffixes and canonical blocks, with paragraph fallback for ineligible inputs', () => {
  for (const suffix of ['', '  Task 🐋\r\n\r\n=== TASK ===\ntrailing  ']) {
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: prefix + suffix },
      { type: 'image-ref', path: '/image.png' }
    ]
    const original = structuredClone(blocks)
    expect(agentMessageDisplayText(blocks, task)).toBe(suffix)
    expect(agentMessageTranscriptText(blocks, task)).toBe(suffix)
    expect(agentMessageDisplayText(blocks)).toBeUndefined()
    expect(blocks).toEqual(original)
  }
  for (const blocks of [
    [{ type: 'text', text: 'ordinary prose' }],
    [
      {
        type: 'text',
        text: `${grammar.ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n${'x'.repeat(24_576)}\n=== TASK ===\nlate`
      }
    ]
  ] satisfies NativeChatBlock[][]) {
    expect(agentMessageDisplayText(blocks, task)).toBeUndefined()
    expect(agentMessageTranscriptText(blocks, task)).toBe(
      blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n\n')
    )
  }
})

it.each([100, 1000])(
  'parses %i real task inputs once and invalidates immutable edited blocks',
  (n) => {
    const parse = vi.spyOn(grammar, 'orcaDispatchTaskBodyOffset')
    const suffix = 'task '.repeat(6000)
    const inputs = Array.from({ length: n }, (): NativeChatBlock[] => [
      { type: 'text', text: prefix + suffix }
    ])
    try {
      for (const blocks of inputs) {
        expect(agentMessageDisplayText(blocks, task)).toBe(suffix)
      }
      expect(parse).toHaveBeenCalledTimes(n)
      parse.mockClear()
      for (const blocks of inputs) {
        expect(agentMessageDisplayText(blocks, task)).toBe(suffix)
      }
      expect(parse).not.toHaveBeenCalled()
      for (const _blocks of inputs) {
        expect(
          agentMessageDisplayText([{ type: 'text', text: `${prefix}${suffix}edited` }], task)
        ).toBe(`${suffix}edited`)
      }
      expect(parse).toHaveBeenCalledTimes(n)
    } finally {
      parse.mockRestore()
    }
  }
)
