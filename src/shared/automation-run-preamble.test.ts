import { describe, expect, it } from 'vitest'
import { automationRunMessageBody, buildAutomationRunPreamble } from './automation-run-preamble'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'
import { AgentJournalItemBodySchema } from './agent-session-journal-schemas'

describe('automation instruction blocks', () => {
  it('tags the instructions and preserves the previous prompt when joined for dispatch', () => {
    const preamble = buildAutomationRunPreamble('orca-dev')
    const task = '  Write the brief\n=== TASK ==='
    const body = automationRunMessageBody(task, preamble.trimEnd())
    expect(AgentJournalItemBodySchema.parse(body)).toEqual(body)
    expect(body.blocks).toEqual([
      { type: 'text', text: preamble.trimEnd(), presentation: 'automation-instructions' },
      { type: 'text', text: task }
    ])
    expect(body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')).toBe(
      preamble + task
    )
    expect(nativeChatMessageCopyText(body)).toBe(task)
  })

  it('copies all non-instruction text and ignores the wording of tagged instructions', () => {
    expect(
      nativeChatMessageCopyText({
        role: 'user',
        blocks: [
          { type: 'text', text: 'Before' },
          { type: 'text', text: 'Future instructions', presentation: 'automation-instructions' },
          { type: 'text', text: 'After', presentation: 'other-presentation' }
        ]
      })
    ).toBe('Before\n\nAfter')
  })

  it('leaves legacy combined messages intact', () => {
    const text = `${buildAutomationRunPreamble('orca')}Write the brief`
    expect(nativeChatMessageCopyText({ role: 'user', blocks: [{ type: 'text', text }] })).toBe(text)
  })
})
