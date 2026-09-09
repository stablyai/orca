import { describe, expect, it } from 'vitest'
import { resolveAutomationListFocusRecovery } from './automation-list-focus-recovery'

describe('automation list focus recovery', () => {
  it('leaves focus alone when the row survived', () => {
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a', 'b', 'c'],
        nextRowKeys: ['a', 'b', 'c'],
        focusedRowKey: 'b'
      })
    ).toBeNull()
  })

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

  it('falls back to the previous row when nothing follows survived', () => {
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a', 'b', 'c'],
        nextRowKeys: ['a'],
        focusedRowKey: 'b'
      })
    ).toEqual({ kind: 'row', rowKey: 'a' })
  })

  it('falls back to the picker when the whole list went', () => {
    expect(
      resolveAutomationListFocusRecovery({
        previousRowKeys: ['a', 'b'],
        nextRowKeys: [],
        focusedRowKey: 'b'
      })
    ).toEqual({ kind: 'picker' })
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
