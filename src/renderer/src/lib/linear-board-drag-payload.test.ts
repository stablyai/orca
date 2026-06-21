import { describe, expect, it } from 'vitest'

import {
  LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES,
  LINEAR_BOARD_DRAG_ISSUE_MIME,
  readLinearBoardIssueDragData,
  writeLinearBoardIssueDragData
} from './linear-board-drag-payload'

class FakeDataTransfer {
  effectAllowed = 'all'
  readonly types: string[] = []
  private readonly data = new Map<string, string>()

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }

  setData(type: string, value: string): void {
    if (!this.types.includes(type)) {
      this.types.push(type)
    }
    this.data.set(type, value)
  }
}

describe('Linear board issue drag payload', () => {
  it('writes and reads the bounded private issue id payload', () => {
    const transfer = new FakeDataTransfer()

    expect(writeLinearBoardIssueDragData(transfer, 'issue-1')).toBe(true)

    expect(transfer.effectAllowed).toBe('move')
    expect(transfer.getData(LINEAR_BOARD_DRAG_ISSUE_MIME)).toBe('issue-1')
    expect(transfer.getData('text/plain')).toBe('issue-1')
    expect(readLinearBoardIssueDragData(transfer)).toEqual({
      status: 'issue',
      issueId: 'issue-1'
    })
  })

  it('reports hidden custom data without treating it as a missing external drag', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(LINEAR_BOARD_DRAG_ISSUE_MIME, '')

    expect(readLinearBoardIssueDragData(transfer)).toEqual({ status: 'hidden' })
  })

  it('reports missing custom data so plain external text cannot trigger fallback moves', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData('text/plain', 'issue-1')

    expect(readLinearBoardIssueDragData(transfer)).toEqual({ status: 'missing' })
  })

  it('rejects oversized issue ids before callers compare them to board issues', () => {
    const transfer = new FakeDataTransfer()
    const secret = 'linear-board-secret'
    transfer.setData(
      LINEAR_BOARD_DRAG_ISSUE_MIME,
      secret + 'x'.repeat(LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES)
    )

    expect(readLinearBoardIssueDragData(transfer)).toEqual({
      status: 'rejected',
      reason: 'too-large'
    })
  })

  it('rejects multibyte oversized issue ids before board comparisons', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(LINEAR_BOARD_DRAG_ISSUE_MIME, '😀'.repeat(257))

    expect(readLinearBoardIssueDragData(transfer)).toEqual({
      status: 'rejected',
      reason: 'too-large'
    })
  })

  it('does not write oversized issue ids', () => {
    const transfer = new FakeDataTransfer()

    expect(
      writeLinearBoardIssueDragData(transfer, 'x'.repeat(LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES + 1))
    ).toBe(false)
    expect(transfer.types).toEqual([])
  })
})
