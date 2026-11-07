import { describe, expect, it } from 'vitest'
import { resolveAutomationListFocusRecovery } from './automation-list-focus-recovery'

describe('automation list focus recovery', () => {
  it('leaves focus alone when it was never on a row', () => {
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a'],
        nextRowKeys: [],
        focusedRowKey: null
      })
    ).toBeNull()
  })

  it('moves to the next surviving row', () => {
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a', 'b', 'c'],
        nextRowKeys: ['a', 'c'],
        focusedRowKey: 'b'
      })
    ).toEqual({ kind: 'row', rowKey: 'c' })
  })

  it('goes to the picker when the lost row was never in this list', () => {
    // A host switch replaces every row, so no neighbor here is the right one.
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a', 'b'],
        nextRowKeys: ['x', 'y'],
        focusedRowKey: 'z'
      })
    ).toEqual({ kind: 'picker' })
  })
})
