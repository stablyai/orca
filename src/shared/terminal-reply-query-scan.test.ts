import { describe, expect, it } from 'vitest'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  scanMode2031ReplyDecision
} from './terminal-color-scheme-protocol'

/** Exactly what terminal.ts's subscribe path concatenates into the replay push. */
function replayDataFor(chunks: readonly string[]): string {
  let state = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  let seq = 0
  let replay = ''
  for (const chunk of chunks) {
    const scan = scanTerminalReplyQuerySequences(chunk, seq, state)
    state = scan.state
    seq += chunk.length
    replay += scan.queries.map((query) => query.data).join('')
  }
  return replay
}

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

// A late-attaching remote/mobile client is handed these sequences because the scrollback
// snapshot it also receives carries no control bytes. Carrying the 2031 arm without its
// withdraw made the client register a subscription the TUI had already retired, and the
// remote renderer then pushed CSI ?997;Nn into the shell on the next theme flip (#9993).
describe('replayed DECSET 2031 state matches the TUI final state (#9993)', () => {
  it('carries the withdraw alongside the arm', () => {
    const result = scanTerminalReplyQuerySequences(
      '\x1b[?2031h\x1b[6nprompt$ \x1b[?2031l',
      0,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )

    expect(result.queries).toEqual([
      { data: '\x1b[?2031h', startSeq: 0, endSeq: 8 },
      { data: '\x1b[6n', startSeq: 8, endSeq: 12 },
      { data: '\x1b[?2031l', startSeq: 20, endSeq: 28 }
    ])
  })

  it('leaves a fish prompt-accept replay UNSUBSCRIBED, as fish actually is', () => {
    // fish arms 2031 while painting the prompt and withdraws it before exec'ing the command.
    const replay = replayDataFor([
      '\x1b[?2004h\x1b[?2031h',
      '~/orca ❯ ',
      '\x1b[?2004l\x1b[?2031l',
      'npx running now'
    ])

    expect(replay).toBe('\x1b[?2031h\x1b[?2031l')
    expect(scanMode2031ReplyDecision(INITIAL_MODE_2031_REPLY_SCAN_STATE, replay).decision).toBe(
      'unsubscribed'
    )
  })

  it('leaves a still-armed TUI SUBSCRIBED so it keeps receiving theme flips', () => {
    const replay = replayDataFor(['\x1b[?2031h', 'a TUI that stays subscribed'])

    expect(replay).toBe('\x1b[?2031h')
    expect(scanMode2031ReplyDecision(INITIAL_MODE_2031_REPLY_SCAN_STATE, replay).decision).toBe(
      'subscribed'
    )
  })

  it('resolves a rearm after a withdraw to the last toggle, in byte order', () => {
    const replay = replayDataFor(['\x1b[?2031h', 'x\x1b[?2031l', 'y\x1b[?2031h'])

    expect(replay).toBe('\x1b[?2031h\x1b[?2031l\x1b[?2031h')
    expect(scanMode2031ReplyDecision(INITIAL_MODE_2031_REPLY_SCAN_STATE, replay).decision).toBe(
      'subscribed'
    )
  })
})
