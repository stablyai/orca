import { describe, expect, it } from 'vitest'
import {
  JIRA_BOARD_DRAG_ISSUE_MIME,
  JIRA_BOARD_DRAG_ISSUE_REF_MAX_BYTES,
  readJiraBoardIssueDragData,
  writeJiraBoardIssueDragData
} from './jira-board-drag-payload'

function createDataTransfer(): Pick<DataTransfer, 'setData' | 'getData' | 'types'> & {
  effectAllowed: string
} {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'none',
    setData: (format: string, value: string) => {
      data.set(format, value)
    },
    getData: (format: string) => data.get(format) ?? '',
    get types() {
      return [...data.keys()]
    }
  }
}

describe('jira board drag payload', () => {
  it('round-trips an issue ref with siteId', () => {
    const transfer = createDataTransfer()
    expect(writeJiraBoardIssueDragData(transfer, { key: 'STA-42', siteId: 'site-1' })).toBe(true)
    expect(transfer.effectAllowed).toBe('move')
    expect(readJiraBoardIssueDragData(transfer)).toEqual({
      status: 'issue',
      ref: { key: 'STA-42', siteId: 'site-1' }
    })
  })

  it('round-trips an issue ref without siteId', () => {
    const transfer = createDataTransfer()
    expect(writeJiraBoardIssueDragData(transfer, { key: 'STA-42' })).toBe(true)
    expect(readJiraBoardIssueDragData(transfer)).toEqual({
      status: 'issue',
      ref: { key: 'STA-42' }
    })
  })

  it('rejects writing an empty key', () => {
    const transfer = createDataTransfer()
    expect(writeJiraBoardIssueDragData(transfer, { key: '' })).toBe(false)
    expect(transfer.types).toEqual([])
  })

  it('rejects writing an oversized ref', () => {
    const transfer = createDataTransfer()
    const key = 'K'.repeat(JIRA_BOARD_DRAG_ISSUE_REF_MAX_BYTES + 1)
    expect(writeJiraBoardIssueDragData(transfer, { key })).toBe(false)
  })

  it('reports hidden while the typed payload is unreadable during dragover', () => {
    const transfer = createDataTransfer()
    transfer.setData(JIRA_BOARD_DRAG_ISSUE_MIME, '')
    expect(readJiraBoardIssueDragData(transfer)).toEqual({ status: 'hidden' })
  })

  it('reports missing when no jira payload is present', () => {
    const transfer = createDataTransfer()
    transfer.setData('text/plain', 'not-a-jira-ref')
    expect(readJiraBoardIssueDragData(transfer)).toEqual({ status: 'missing' })
  })

  it('rejects malformed payloads', () => {
    for (const payload of [
      'not json',
      '"just a string"',
      '{}',
      '{"key":42}',
      '{"key":"A","siteId":7}'
    ]) {
      const transfer = createDataTransfer()
      transfer.setData(JIRA_BOARD_DRAG_ISSUE_MIME, payload)
      expect(readJiraBoardIssueDragData(transfer).status).toBe('rejected')
    }
  })
})
