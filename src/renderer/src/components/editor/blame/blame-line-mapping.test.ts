import { describe, expect, it } from 'vitest'
import { mapBufferLinesToHead, splitBlameLines, UNCOMMITTED_LINE as U } from './blame-line-mapping'

describe('mapBufferLinesToHead', () => {
  it('keeps unchanged lines on their HEAD line and marks edits uncommitted', () => {
    const head = ['a', 'b', 'c', 'd', 'e']
    // Inserted line after 'a', 'c' edited, 'd' deleted.
    const buffer = ['a', 'new', 'b', 'c!', 'e']
    expect(Array.from(mapBufferLinesToHead(head, buffer)!)).toEqual([0, U, 1, U, 4])
  })

  it('treats a CRLF checkout of LF HEAD content as unchanged', () => {
    const head = splitBlameLines('one\ntwo\n')
    const buffer = splitBlameLines('one\r\ntwo\r\n')
    expect(Array.from(mapBufferLinesToHead(head, buffer)!)).toEqual([0, 1, 2])
  })
})
