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
    outlivesTurn: false,
    reportsFailure: false,
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

  describe('a failure row', () => {
    const failure = (overrides: Partial<NativeChatTurnFoldRow> = {}) =>
      row({ role: 'system', rendersProse: false, reportsFailure: true, ...overrides })
    const fold = (rows: NativeChatTurnFoldRow[]) =>
      nativeChatTurnFold({ rows, settledTurnKeys: SETTLED, expandedTurnKeys: NONE }).foldedRows

    it('stays in view when the turn ended in it', () => {
      expect([...fold([row({ role: 'user' }), row({ rendersProse: false }), failure()])]).toEqual([
        1
      ])
    })

    it('stays in view after a partial answer, as the last row of its turn', () => {
      const folded = fold([row({ role: 'user' }), row(), row(), failure()])
      expect([...folded]).toEqual([1])
    })

    it('folds with the work when the agent answered after it', () => {
      const folded = fold([row({ role: 'user' }), failure(), row({ rendersProse: false }), row()])
      expect([...folded].sort()).toEqual([1, 2])
    })

    it("stays in view when only a subagent spoke after it, which is not the turn's answer", () => {
      const folded = fold([row({ role: 'user' }), row(), failure(), row({ agentId: 'task-1' })])
      expect(folded.has(2)).toBe(false)
      expect(folded.has(3)).toBe(true)
    })

    it('folds an earlier failure the turn failed past, keeping the one it ended in', () => {
      expect([...fold([row({ role: 'user' }), failure(), failure()])]).toEqual([1])
      const afterAnswer = fold([row({ role: 'user' }), row(), failure(), failure()])
      expect([...afterAnswer]).toEqual([2])
    })

    it('stays in view when it is tied to no turn', () => {
      expect(fold([failure({ turnKey: undefined }), row({ role: 'user' }), row()]).size).toBe(0)
    })
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
})

describe("a subagent's words are never the turn's answer", () => {
  // The reported shape: the parent replies, then a subagent it launched keeps
  // narrating into the same journal after the parent's last word.
  const rows: NativeChatTurnFoldRow[] = [
    row({ role: 'user' }),
    row(),
    row({ agentId: 'task-1' }),
    row({ agentId: 'task-1', rendersProse: false })
  ]

  it("names the session's own last prose, not a subagent's later prose", () => {
    expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(1)
  })

  it("folds the subagent's prose behind a settled turn and keeps the parent's answer", () => {
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: SETTLED,
      expandedTurnKeys: NONE
    })
    expect(foldedRows.has(1)).toBe(false)
    expect(foldedRows.has(2)).toBe(true)
  })

  it('reports no answer for a turn in which only subagents spoke', () => {
    const onlyChildren = [row({ role: 'user' }), row({ agentId: 'task-1' })]
    expect(nativeChatTurnAnswerRows(onlyChildren).has('turn-1')).toBe(false)
  })
})
