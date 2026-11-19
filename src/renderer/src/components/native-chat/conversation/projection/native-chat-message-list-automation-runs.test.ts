import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

const facts = {
  id: 'auto-1',
  name: 'PR acme/widgets#851',
  enabled: true,
  nextRunAt: 0,
  updatedAt: 1,
  dtstart: 1,
  rrule: 'FREQ=DAILY',
  workspaceId: 'folder:bot'
}
const ending = { kind: 'event' as const, at: 50 }
const run = {
  runId: 'run-1',
  automation: facts,
  trigger: 'event' as const,
  wait: ending,
  instructionsLength: 5
}

function row(
  id: string,
  sequence: number,
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 },
    blocks: [],
    ...overrides
  }
}

const say = (id: string, sequence: number) =>
  row(id, sequence, { blocks: [{ type: 'text', text: id }] })
const waitCard = (sequence: number) =>
  row('wait', sequence, { waitEnded: { automation: facts, ending } })
const runRow = (sequence: number) =>
  row('run', sequence, {
    role: 'user',
    blocks: [{ type: 'text', text: 'Merge' }],
    automationRun: run
  })
const notStarted = (sequence: number) =>
  row('not-started', sequence, {
    automationRunNotStarted: { run, actsFor: [], error: 'closed', text: 'Merge', at: 40 }
  })
const ids = (rows: readonly NativeChatMessage[]) => rows.map((message) => message.id)

describe('automation runs in the desktop chat list', () => {
  it('removes a Wait over card when its matching run arrives', () => {
    const project = createNativeChatMessageListProjection()
    const rows = [
      waitCard(1),
      row('other-wait', 2, {
        waitEnded: { automation: { ...facts, id: 'auto-2' }, ending }
      }),
      row('other-kind', 3, {
        waitEnded: { automation: facts, ending: { kind: 'deadline', at: ending.at } }
      }),
      row('other-time', 4, {
        waitEnded: { automation: facts, ending: { ...ending, at: ending.at + 1 } }
      })
    ]
    expect(ids(project(rows).conversation)).toEqual([
      'wait',
      'other-wait',
      'other-kind',
      'other-time'
    ])
    expect(ids(project([...rows, runRow(5)]).conversation)).toEqual([
      'other-wait',
      'other-kind',
      'other-time',
      'run'
    ])
  })

  it("marks a Couldn't start row Sent again once its run arrives, appended live", () => {
    const project = createNativeChatMessageListProjection()
    const first = notStarted(1)
    expect(project([first]).conversation[0]!.automationRunNotStarted!.sentAgain).toBeUndefined()
    const after = project([first, say('b', 2), runRow(3)]).conversation
    expect(ids(after)).toEqual(['not-started', 'b', 'run'])
    expect(after[0]!.automationRunNotStarted!.sentAgain).toBe(true)
  })
})
