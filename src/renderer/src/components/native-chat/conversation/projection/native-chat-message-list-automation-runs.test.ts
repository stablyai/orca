import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type * as FoldUnits from '../../../../../../shared/native-chat/transcript/folding/native-chat-fold-units'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

// Each full pass folds every scope's units once; an incremental pass never does.
const fullPasses = vi.hoisted(() => ({ count: 0 }))
vi.mock(
  '../../../../../../shared/native-chat/transcript/folding/native-chat-fold-units',
  async (importOriginal) => {
    const actual = await importOriginal<typeof FoldUnits>()
    return {
      ...actual,
      buildNativeChatFoldUnits: (...args: Parameters<typeof actual.buildNativeChatFoldUnits>) => {
        fullPasses.count += 1
        return actual.buildNativeChatFoldUnits(...args)
      }
    }
  }
)

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

beforeEach(() => {
  fullPasses.count = 0
})

describe('automation runs in the desktop chat list', () => {
  it('draws a stored Wait over card and its run row once, as the run row', () => {
    const project = createNativeChatMessageListProjection()
    expect(ids(project([say('a', 1), waitCard(2), runRow(3)]).conversation)).toEqual(['a', 'run'])
  })

  it("marks a Couldn't start row Sent again once its run arrives, appended live", () => {
    const project = createNativeChatMessageListProjection()
    const first = notStarted(1)
    expect(project([first]).conversation[0]!.automationRunNotStarted!.sentAgain).toBeUndefined()
    const after = project([first, say('b', 2), runRow(3)]).conversation
    expect(ids(after)).toEqual(['not-started', 'b', 'run'])
    expect(after[0]!.automationRunNotStarted!.sentAgain).toBe(true)
  })

  it('folds a card whose run row is appended later, and keeps plain appends incremental', () => {
    const project = createNativeChatMessageListProjection()
    const rows = [say('a', 1), waitCard(2)]
    project([...rows])
    expect(fullPasses.count).toBe(1)

    rows.push(runRow(3))
    expect(ids(project([...rows]).conversation)).toEqual(['a', 'run'])
    expect(fullPasses.count).toBe(2)

    for (let sequence = 4; sequence < 14; sequence += 1) {
      rows.push(say(`m${sequence}`, sequence))
      project([...rows])
    }
    expect(fullPasses.count).toBe(2)
    expect(ids(project([...rows]).conversation)).not.toContain('wait')
  })
})
