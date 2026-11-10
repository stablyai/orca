import { describe, expect, it } from 'vitest'

import {
  LINEAR_BOARD_DRAG_ISSUE_MIME,
  readLinearBoardIssueDragData
} from './linear-board-drag-payload'

class FakeDataTransfer {
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
  it('rejects multibyte oversized issue ids before board comparisons', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(LINEAR_BOARD_DRAG_ISSUE_MIME, '😀'.repeat(257))

    expect(readLinearBoardIssueDragData(transfer)).toEqual({
      status: 'rejected',
      reason: 'too-large'
    })
  })
})
