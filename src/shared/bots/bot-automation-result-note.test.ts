import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../agent-session/view/structured-agent-session-message-projection'
import {
  AUTOMATION_RESULT_NOTE_MAX_CHARS,
  automationResultNoteBody,
  automationResultsPreamble,
  makeAutomationResultNote,
  readAutomationResultNote,
  type AutomationResultNote
} from './bot-automation-result-note'

function note(index: number, result = `result ${index}`): AutomationResultNote {
  return makeAutomationResultNote({
    automationId: 'auto-1',
    automationName: `Automation ${index}`,
    botName: 'Atlas',
    runId: `run-${index}`,
    trigger: 'schedule',
    outcome: index % 2 === 0 ? 'finished' : 'couldNotFinish',
    result,
    at: index * 1_000
  })
}

const time = (at: number): string => `t${at / 1_000}`

describe('automationResultsPreamble', () => {
  it('lists the newest 10 oldest first, counts earlier results and closes the bracket', () => {
    const notes = Array.from({ length: 13 }, (_, index) => note(13 - index))
    const lines = automationResultsPreamble(notes, time).split('\n')
    expect(lines[0]).toBe(
      "[Since your last message: 13 automation results arrived in this chat. You haven't seen them; the user saw them as notes."
    )
    expect(lines[1]).toBe('+3 earlier results')
    expect(lines.slice(2)).toHaveLength(10)
    expect(lines[2]).toBe('- t4, Automation 4, finished: result 4')
    expect(lines[3]).toBe("- t5, Automation 5, couldn't finish: result 5")
    expect(lines.at(-1)).toBe("- t13, Automation 13, couldn't finish: result 13]")
  })

  it('stays within 4,000 characters by counting the oldest lines instead', () => {
    const notes = Array.from({ length: 10 }, (_, index) => note(index + 1, 'y'.repeat(600)))
    const preamble = automationResultsPreamble(notes, time)
    expect(preamble.length).toBeLessThanOrEqual(4_000)
    expect(preamble).toMatch(/\n\+\d earlier results\n/)
    expect(preamble).toContain('Automation 10,')
    expect(preamble.endsWith(']')).toBe(true)
  })
})

describe('cutting a result', () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  it('never splits an emoji that straddles a cap', () => {
    // The emoji's two code units sit at the cut, for the per-result and the stored caps.
    const perResult = automationResultsPreamble([note(2, `${'a'.repeat(398)}😀tail`)], time)
    expect(perResult).not.toMatch(loneSurrogate)
    expect(perResult).toContain(`${'a'.repeat(398)}…`)
    const stored = note(2, `${'z'.repeat(AUTOMATION_RESULT_NOTE_MAX_CHARS - 2)}😀tail`).result
    expect(stored).not.toMatch(loneSurrogate)
    expect(stored.endsWith('z…')).toBe(true)
  })
})

describe('automation result notes and a context clear', () => {
  const at = (sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem => ({
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body
  })
  const clear = at(5, {
    kind: 'status',
    text: 'Context cleared',
    presentation: 'context-cleared',
    contextClear: { operationId: 'clear-5', afterFence: 1, clearedAt: 5 }
  })
  const cleared = (items: AgentJournalRenderItem[]) =>
    projectStructuredAgentSessionMessages(items, [], []).flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === 'text' && block.automationResult
          ? [[block.automationResult.runId, block.automationResultCleared === true]]
          : []
      )
    )

  it('marks an unread note older than the clear, and nothing else', () => {
    const read = { ...note(4), runId: 'read', readWith: 'message-1' }
    expect(
      cleared([
        at(1, automationResultNoteBody({ ...note(2), runId: 'before' })),
        at(2, automationResultNoteBody(read)),
        clear,
        at(6, automationResultNoteBody({ ...note(4), runId: 'after' }))
      ])
    ).toEqual([
      ['before', true],
      ['read', false],
      ['after', false]
    ])
  })
})

describe('automation result note body', () => {
  it('keeps a plain line for clients that predate the note', () => {
    const body = automationResultNoteBody(note(2, '\nFirst line\nSecond line'))
    expect(body.text).toBe('Automation 2 finished: First line')
    expect(body.presentation).toBe('automation-result')
    expect(readAutomationResultNote(body.automationResult)).toEqual(body.automationResult)
  })

  it('reads nothing that is not a note', () => {
    expect(readAutomationResultNote({ runId: 'run-1' })).toBeNull()
    expect(readAutomationResultNote({ ...note(2), trigger: 'webhook' })).toBeNull()
  })
})
