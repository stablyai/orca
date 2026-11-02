import { describe, expect, it } from 'vitest'
import { readAgentJournalMessageBody } from './agent-session-journal-body-admission'

describe("a submission's body", () => {
  it('reads a message, a newer kind as unreadable, and another known kind as damage', () => {
    expect(readAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [] })).toBe(
      'readable'
    )
    expect(readAgentJournalMessageBody({ kind: 'voice-note', clip: 'x' })).toBe('unreadable')
    expect(readAgentJournalMessageBody({ kind: ' ' })).toBe('malformed')
    expect(readAgentJournalMessageBody({ kind: 'status', text: 'x' })).toBe('malformed')
    expect(
      readAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [{ type: 'text' }] })
    ).toBe('malformed')
  })
})
