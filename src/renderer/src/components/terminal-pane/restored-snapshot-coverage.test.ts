import { describe, expect, it } from 'vitest'
import { restoredSnapshotPaintsPrintableContent } from './restored-snapshot-coverage'

describe('restoredSnapshotPaintsPrintableContent', () => {
  it('accepts a snapshot with cell content in the frame or the scrollback', () => {
    expect(restoredSnapshotPaintsPrintableContent({ data: '\x1b[0m$ ls\r\n' })).toBe(true)
    expect(
      restoredSnapshotPaintsPrintableContent({
        data: '\x1b[H\x1b[2J',
        scrollbackAnsi: 'older\r\n'
      })
    ).toBe(true)
  })

  it('rejects a mode-rehydration-only image, which no amount of output renders to', () => {
    expect(
      restoredSnapshotPaintsPrintableContent({
        data: '\x1b[0m\x1b[?25h\x1b[?7h'
      })
    ).toBe(false)
    expect(restoredSnapshotPaintsPrintableContent({ data: '\x1b]0;title\x07' })).toBe(false)
    expect(restoredSnapshotPaintsPrintableContent({})).toBe(false)
    expect(
      restoredSnapshotPaintsPrintableContent({
        data: '\x1b[2J',
        scrollbackAnsi: '  \r\n\t'
      })
    ).toBe(false)
  })
})
