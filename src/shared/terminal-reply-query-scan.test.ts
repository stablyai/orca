import { describe, expect, it } from 'vitest'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'

describe('terminal reply query scan', () => {
  it('records reply-eliciting queries with their output high-water sequence', () => {
    const data = `before\x1b[6nafter\x1b[?2031h`
    const result = scanTerminalReplyQuerySequences(data, 100, EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)

    expect(result.queries).toEqual([
      { data: '\x1b[6n', startSeq: 106, endSeq: 110 },
      { data: '\x1b[?2031h', startSeq: 115, endSeq: 123 }
    ])
    expect(result.state).toEqual(EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)
  })

  it('assembles a query split across contiguous PTY chunks', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 23, first.state)

    expect(first.queries).toEqual([])
    expect(second.queries).toEqual([{ data: '\x1b[?2026$p', startSeq: 20, endSeq: 29 }])
  })

  it('drops a partial query when output sequence continuity is lost', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 30, first.state)

    expect(second.queries).toEqual([])
  })
})
