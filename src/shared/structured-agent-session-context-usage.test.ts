import { describe, expect, it } from 'vitest'
import type {
  AgentSessionContextReport,
  AgentSessionContextUsage,
  AgentSessionContextWindow
} from './agent-session-context-usage'
import type { AgentJournalItemBody, AgentJournalRenderItem } from './agent-session-journal-types'
import {
  latestStructuredAgentContextFacts,
  selectStructuredAgentContextUsage
} from './structured-agent-session-context-usage'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence * 1_000, body }
}

const REPORT: AgentSessionContextReport = {
  model: 'claude-fable-5-1',
  usedTokens: 29_400,
  windowTokens: 200_000,
  percentage: 15,
  autoCompactAtTokens: 167_000,
  categories: [{ name: 'Messages', tokens: 10_200 }],
  capturedAt: 5_000
}

const WINDOW: AgentSessionContextWindow = { tokens: 1_000_000, capturedAt: 2_000 }

function estimate(usedTokens: number): AgentSessionContextUsage['used'] {
  return {
    kind: 'estimate',
    usage: {
      inputTokens: usedTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 4
    },
    capturedAt: 1
  }
}

function turn(sequence: number, contextUsage: AgentSessionContextUsage): AgentJournalRenderItem {
  return item(`turn-${sequence}`, sequence, {
    kind: 'turn',
    turnId: `turn-${sequence}`,
    state: 'completed',
    contextUsage
  })
}

describe('selectStructuredAgentContextUsage', () => {
  it('reads the report on the newest turn that carries a used count', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(20_000), window: WINDOW }),
        turn(3, { used: { kind: 'report', ...REPORT } })
      ])
    ).toEqual({
      usedTokens: 29_400,
      windowTokens: 200_000,
      percentage: 15,
      estimated: false,
      categories: REPORT.categories
    })
  })

  it('orders by journal position, not by the clock on the fact', () => {
    const late = { ...REPORT, capturedAt: 99_000 }
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: { kind: 'report', ...late }, window: WINDOW }),
        turn(2, { used: estimate(54_617) })
      ])
    ).toMatchObject({ usedTokens: 54_617, windowTokens: 1_000_000, estimated: true })
  })

  it('estimates against the newest window, which may sit on an older turn', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(10_000), window: WINDOW }),
        turn(2, { used: estimate(18_600) })
      ])
    ).toEqual({
      usedTokens: 18_600,
      windowTokens: 1_000_000,
      percentage: 2,
      estimated: true,
      categories: []
    })
  })

  it('divides by the newest window, not the one written beside the estimate', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(150_000), window: WINDOW }),
        turn(2, { window: { tokens: 200_000, capturedAt: 3_000 } })
      ])
    ).toMatchObject({ usedTokens: 150_000, windowTokens: 200_000, percentage: 75 })
  })

  it('keeps the last turn with a count while a new turn has none yet', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(18_600), window: WINDOW }),
        item('turn-2', 2, { kind: 'turn', turnId: 'turn-2', state: 'running' })
      ])
    ).toMatchObject({ usedTokens: 18_600 })
  })

  it('states nothing before the CLI has reported a window', () => {
    expect(selectStructuredAgentContextUsage([turn(1, { used: estimate(18_600) })])).toBeNull()
  })

  it('hides the pre-compaction size until the next response or report restates it', () => {
    const before = turn(1, { used: estimate(150_000), window: WINDOW })
    const compacted = turn(2, { used: { kind: 'unknown', capturedAt: 3_000 } })
    expect(selectStructuredAgentContextUsage([before, compacted])).toBeNull()
    expect(
      selectStructuredAgentContextUsage([before, compacted, turn(3, { used: estimate(12_000) })])
    ).toMatchObject({ usedTokens: 12_000, estimated: true })
    expect(
      selectStructuredAgentContextUsage([before, turn(2, { used: { kind: 'report', ...REPORT } })])
    ).toMatchObject({ usedTokens: 29_400, estimated: false })
  })

  it('states nothing for a used kind a newer host writes', () => {
    const future = { kind: 'forecast', capturedAt: 4_000 }
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(18_600), window: WINDOW }),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a row from a newer host, which no local type admits.
        turn(2, { used: future as unknown as AgentSessionContextUsage['used'] })
      ])
    ).toBeNull()
  })

  it('is null for a journal with neither', () => {
    expect(
      selectStructuredAgentContextUsage([
        item('u', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] })
      ])
    ).toBeNull()
  })

  it('fills a part the loaded rows lack from the host whole-journal answer', () => {
    const wholeJournal = { used: estimate(90_000), window: WINDOW }
    expect(selectStructuredAgentContextUsage([], wholeJournal)).toMatchObject({
      usedTokens: 90_000,
      windowTokens: 1_000_000
    })
    // The window was written on a turn row older than the loaded page.
    expect(
      selectStructuredAgentContextUsage([turn(40, { used: estimate(120_000) })], wholeJournal)
    ).toMatchObject({ usedTokens: 120_000, windowTokens: 1_000_000, estimated: true })
  })

  it('prefers each part the loaded rows carry over the host answer', () => {
    const wholeJournal = { used: estimate(90_000), window: { tokens: 200_000, capturedAt: 1 } }
    expect(
      selectStructuredAgentContextUsage(
        [turn(40, { used: estimate(120_000), window: WINDOW })],
        wholeJournal
      )
    ).toMatchObject({ usedTokens: 120_000, windowTokens: 1_000_000 })
    // An unknown size in the loaded rows is newer than any size the host holds for older rows.
    expect(
      selectStructuredAgentContextUsage(
        [turn(40, { used: { kind: 'unknown', capturedAt: 3_000 } })],
        wholeJournal
      )
    ).toBeNull()
  })
})

describe('latestStructuredAgentContextFacts', () => {
  it('answers the same for rows in any order, as the host holds them', () => {
    const rows = [
      turn(1, { used: estimate(18_600), window: WINDOW }),
      turn(2, { used: { kind: 'report', ...REPORT } }),
      turn(3, { used: estimate(40_000) }),
      item('u', 4, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] })
    ]
    const facts = latestStructuredAgentContextFacts(rows)
    expect(facts).toEqual({ used: estimate(40_000), window: WINDOW })
    expect(latestStructuredAgentContextFacts(rows.toReversed())).toEqual(facts)
    expect(latestStructuredAgentContextFacts([])).toEqual({})
  })
})
