import { describe, expect, it } from 'vitest'
import {
  nativeChatTurnAnswerRows,
  nativeChatTurnFold,
  type NativeChatTurnFoldRow
} from './native-chat-turn-fold'

function row(overrides: Partial<NativeChatTurnFoldRow> = {}): NativeChatTurnFoldRow {
  return {
    turnKey: 'turn-1',
    role: 'assistant',
    rendersProse: true,
    draws: true,
    outlivesTurn: false,
    reportsFailure: false,
    reportsCompaction: false,
    ...overrides
  }
}

/** The turn in the reported session: a prompt, narration, work, then the answer. */
const TURN: NativeChatTurnFoldRow[] = [
  row({ role: 'user' }),
  row(),
  row({ rendersProse: false }),
  row(),
  row()
]

/** An error-toned system row: the agent or host reporting the turn failed. */
const FAILURE = row({ role: 'system', reportsFailure: true })

const SETTLED = new Set(['turn-1'])
const NONE = new Set<string>()

describe('nativeChatTurnAnswerRows', () => {
  it('names the last assistant row that renders prose, not the first', () => {
    expect(nativeChatTurnAnswerRows(TURN).get('turn-1')).toBe(4)
  })

  it('ignores rows that render no prose, so a trailing tool run is not the answer', () => {
    const rows = [row({ role: 'user' }), row(), row({ rendersProse: false })]
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(1)
  })

  it('ignores reasoning and system rows, which are never the agent answering', () => {
    const rows = [row({ role: 'user' }), row(), row({ role: 'reasoning' }), row({ role: 'system' })]
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(1)
  })

  it('names a failure report as the answer when nothing the agent said comes after it', () => {
    const rows = [row({ role: 'user' }), row(), FAILURE]
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(2)
  })

  it('names the later prose as the answer when the agent recovered from a failure', () => {
    const rows = [row({ role: 'user' }), FAILURE, row()]
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(2)
  })

  it('reports no answer for a turn that only ran tools', () => {
    const rows = [row({ role: 'user' }), row({ rendersProse: false })]
    expect(nativeChatTurnAnswerRows(rows).has('turn-1')).toBe(false)
  })
})

describe('nativeChatTurnFold', () => {
  it('folds a settled turn to its answer', () => {
    const { foldedRows } = nativeChatTurnFold({
      rows: TURN,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2, 3])
  })

  it("never folds the reader's own message, which anchors the turn", () => {
    const { foldedRows } = nativeChatTurnFold({
      rows: TURN,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.has(0)).toBe(false)
  })

  // A stored-only provider event draws nothing: a disclosure over it would open onto nothing.
  it('offers no disclosure for a turn whose only other row draws nothing', () => {
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows: [
        row({ role: 'user' }),
        row({ role: 'system', rendersProse: false, draws: false }),
        row()
      ],
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.size).toBe(0)
    expect(foldableTurnKeys.size).toBe(0)
  })

  it('folds nothing while the turn is still running', () => {
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows: TURN,
      settledTurnKeys: NONE,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.size).toBe(0)
    expect(foldableTurnKeys.size).toBe(0)
  })

  it('reveals every row of a turn the reader opened, and still reports it foldable', () => {
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows: TURN,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: SETTLED
    })
    expect(foldedRows.size).toBe(0)
    expect([...foldableTurnKeys]).toEqual(['turn-1'])
  })

  it('keeps a spawn roster or background task out of the fold', () => {
    const rows = [row({ role: 'user' }), row(), row({ outlivesTurn: true }), row()]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.has(2)).toBe(false)
    expect(foldedRows.has(1)).toBe(true)
  })

  it('folds a prose-less turn whole, so its commands do not return to the transcript', () => {
    const rows = [row({ role: 'user' }), row({ rendersProse: false }), row({ rendersProse: false })]
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
    expect([...foldableTurnKeys]).toEqual(['turn-1'])
  })

  it('offers no disclosure on a turn that is nothing but its answer', () => {
    const rows = [row({ role: 'user' }), row()]
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.size).toBe(0)
    expect(foldableTurnKeys.size).toBe(0)
  })

  it('folds each settled turn to its own answer and leaves a running turn alone', () => {
    const rows = [
      row({ turnKey: 'turn-1', role: 'user' }),
      row({ turnKey: 'turn-1' }),
      row({ turnKey: 'turn-1' }),
      row({ turnKey: 'turn-2', role: 'user' }),
      row({ turnKey: 'turn-2' }),
      row({ turnKey: 'turn-2' })
    ]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: new Set(['turn-1']),
      expandedTurnKeys: NONE
    })
    expect([...foldedRows]).toEqual([1])
  })

  it('leaves rows before the first prompt alone', () => {
    const rows = [row({ turnKey: undefined }), row({ turnKey: undefined })]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.size).toBe(0)
  })

  it('ends a failed turn on its error, folding the work and prose before it', () => {
    const rows = [row({ role: 'user' }), row(), row({ rendersProse: false }), FAILURE]
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
    expect([...foldableTurnKeys]).toEqual(['turn-1'])
  })

  it('folds an error the agent recovered from behind the answer that followed it', () => {
    const rows = [row({ role: 'user' }), row({ rendersProse: false }), FAILURE, row()]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows].sort()).toEqual([1, 2])
  })

  it('shows a turn that is nothing but its error as that error, with no disclosure', () => {
    const rows = [row({ role: 'user' }), FAILURE]
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.size).toBe(0)
    expect(foldableTurnKeys.size).toBe(0)
  })

  it('never folds a compaction report, and keeps the last prose as the answer', () => {
    const rows = [
      row({ role: 'user' }),
      row(),
      row({ role: 'system', reportsCompaction: true }),
      row(),
      row({ role: 'system', reportsCompaction: true })
    ]
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect([...foldedRows]).toEqual([1])
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(3)
  })
})
