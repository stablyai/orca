import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_QUERY_OUTSTANDING_TTL_MS,
  TerminalQueryOwnerTracker
} from './terminal-query-owner'

afterEach(() => vi.useRealTimers())

describe('TerminalQueryOwnerTracker', () => {
  it('records the owner that starts a split OSC query', () => {
    let foreground = 'gh'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)

    tracker.accept({ data: '\x1b]11;?', rawStartSeq: 0, rawEndSeq: 6 })
    foreground = 'node'
    tracker.accept({ data: '\x07', rawStartSeq: 6, rawEndSeq: 7 })

    expect(tracker.owner).toBe('gh')
  })

  it('does not replace the owner for non-query output', () => {
    let foreground = 'gh'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b]11;?\x07', rawStartSeq: 0, rawEndSeq: 7 })

    foreground = 'node'
    tracker.accept({ data: 'ordinary output', rawStartSeq: 7, rawEndSeq: 22 })

    expect(tracker.owner).toBe('gh')
  })

  it('uses the latest owner when a split query and a new query complete together', () => {
    let foreground = 'gh'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b]10;?', rawStartSeq: 0, rawEndSeq: 6 })

    foreground = 'node'
    tracker.accept({ data: '\x07\x1b]11;?\x07', rawStartSeq: 6, rawEndSeq: 14 })

    expect(tracker.owner).toBe('node')
  })

  it.each([
    ['\x1b[6n', '\x1b[12;34R'],
    ['\x1b[c', '\x1b[?1;2c'],
    ['\x1b[14t', '\x1b[4;768;1024t'],
    ['\x1b[?25$p', '\x1b[?25;1$y'],
    ['\x1b[?u', '\x1b[?3u'],
    ['\x1bP$qm\x1b\\', '\x1bP1$r0m\x1b\\'],
    ['\x1b[>q', '\x1bP>|Orca 1.4\x1b\\']
  ])('claims the owner of %j for its matching reply', (query, reply) => {
    const tracker = new TerminalQueryOwnerTracker(() => 'orb')

    tracker.accept({ data: query, rawStartSeq: 0, rawEndSeq: query.length })

    expect(tracker.claimReplyOwner(reply)).toEqual({ matched: true, owner: 'orb' })
  })

  it('does not claim a modified F3 keystroke without an outstanding CPR query', () => {
    const tracker = new TerminalQueryOwnerTracker(() => 'zsh')

    expect(tracker.claimReplyOwner('\x1b[1;2R')).toEqual({ matched: false })
  })

  it('matches outstanding queries by reply kind instead of only the latest query', () => {
    let foreground = 'first'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 0, rawEndSeq: 4 })
    foreground = 'second'
    tracker.accept({ data: '\x1b[c', rawStartSeq: 4, rawEndSeq: 7 })

    expect(tracker.claimReplyOwner('\x1b[?1;2c')).toEqual({ matched: true, owner: 'second' })
    expect(tracker.claimReplyOwner('\x1b[12;34R')).toEqual({ matched: true, owner: 'first' })
  })

  it('replaces an abandoned same-kind query when a new owner asks again', () => {
    let foreground = 'first'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 0, rawEndSeq: 4 })
    foreground = 'second'
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 4, rawEndSeq: 8 })

    expect(tracker.claimReplyOwner('\x1b[12;34R')).toEqual({ matched: true, owner: 'second' })
    expect(tracker.claimReplyOwner('\x1b[12;34R')).toEqual({ matched: false })
  })

  it('keeps the older claim when the same owner asks the same query again', () => {
    const tracker = new TerminalQueryOwnerTracker(() => 'gh')
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 0, rawEndSeq: 4 })
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 4, rawEndSeq: 8 })

    expect(tracker.claimReplyOwner('\x1b[12;34R')).toEqual({ matched: true, owner: 'gh' })
    expect(tracker.claimReplyOwner('\x1b[34;12R')).toEqual({ matched: true, owner: 'gh' })
  })

  it.each([
    [
      'OSC 10/11',
      '\x1b]10;?\x07',
      '\x1b]11;?\x07',
      '\x1b]10;rgb:aa/aa/aa\x07',
      '\x1b]11;rgb:bb/bb/bb\x07'
    ],
    ['standard/private CPR', '\x1b[6n', '\x1b[?6n', '\x1b[12;34R', '\x1b[?12;5R'],
    ['DA1/DA2', '\x1b[c', '\x1b[>c', '\x1b[?1;2c', '\x1b[>0;276;0c'],
    ['window reports', '\x1b[14t', '\x1b[16t', '\x1b[4;768;1024t', '\x1b[6;16;8t'],
    ['DECRPM parameters', '\x1b[?25$p', '\x1b[?26$p', '\x1b[?25;1$y', '\x1b[?26;1$y'],
    ['DECRPM private/ANSI marker', '\x1b[?25$p', '\x1b[4$p', '\x1b[?25;1$y', '\x1b[4;1$y'],
    [
      'DCS DECRQSS/XTVERSION',
      '\x1bP$qm\x1b\\',
      '\x1b[>q',
      '\x1bP1$r0m\x1b\\',
      '\x1bP>|Orca 1.4\x1b\\'
    ]
  ])(
    'correlates %s replies to their own owner across different owners',
    (_label, queryA, queryB, replyA, replyB) => {
      let foreground = 'owner-a'
      const tracker = new TerminalQueryOwnerTracker(() => foreground)
      tracker.accept({ data: queryA, rawStartSeq: 0, rawEndSeq: queryA.length })
      foreground = 'owner-b'
      tracker.accept({
        data: queryB,
        rawStartSeq: queryA.length,
        rawEndSeq: queryA.length + queryB.length
      })

      expect(tracker.claimReplyOwner(replyA)).toEqual({ matched: true, owner: 'owner-a' })
      expect(tracker.claimReplyOwner(replyB)).toEqual({ matched: true, owner: 'owner-b' })
    }
  )

  it.each([
    ['10 then 11', '\x1b]10;rgb:aa/aa/aa\x07', '\x1b]11;rgb:bb/bb/bb\x07'],
    ['11 then 10', '\x1b]11;rgb:bb/bb/bb\x07', '\x1b]10;rgb:aa/aa/aa\x07']
  ])('claims both replies of an OSC 10 ?;? query in order %s', (_label, first, second) => {
    const tracker = new TerminalQueryOwnerTracker(() => 'orb')
    tracker.accept({ data: '\x1b]10;?;?\x07', rawStartSeq: 0, rawEndSeq: 9 })

    expect(tracker.claimReplyOwner(first)).toEqual({ matched: true, owner: 'orb' })
    expect(tracker.claimReplyOwner(second)).toEqual({ matched: true, owner: 'orb' })
    expect(tracker.claimReplyOwner('\x1b]11;rgb:cc/cc/cc\x07')).toEqual({ matched: false })
  })

  it('retires only the overlapping OSC identity when a new owner asks the other slot', () => {
    let foreground = 'first'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b]10;?;?\x07', rawStartSeq: 0, rawEndSeq: 9 })
    foreground = 'second'
    tracker.accept({ data: '\x1b]11;?\x07', rawStartSeq: 9, rawEndSeq: 16 })

    // The older dual query keeps its OSC 10 claim for its own owner...
    expect(tracker.claimReplyOwner('\x1b]10;rgb:aa/aa/aa\x07')).toEqual({
      matched: true,
      owner: 'first'
    })
    // ...while the OSC 11 claim now belongs to the new owner.
    expect(tracker.claimReplyOwner('\x1b]11;rgb:bb/bb/bb\x07')).toEqual({
      matched: true,
      owner: 'second'
    })
  })

  it('conservatively replaces only the same identity when a new owner asks again', () => {
    let foreground = 'first'
    const tracker = new TerminalQueryOwnerTracker(() => foreground)
    tracker.accept({ data: '\x1b]10;?;?\x07', rawStartSeq: 0, rawEndSeq: 9 })
    foreground = 'second'
    tracker.accept({ data: '\x1b]10;?\x07', rawStartSeq: 9, rawEndSeq: 16 })

    // The re-asked OSC 10 identity moves to the new owner; the un-asked OSC 11
    // identity survives for the original owner.
    expect(tracker.claimReplyOwner('\x1b]11;rgb:bb/bb/bb\x07')).toEqual({
      matched: true,
      owner: 'first'
    })
    expect(tracker.claimReplyOwner('\x1b]10;rgb:aa/aa/aa\x07')).toEqual({
      matched: true,
      owner: 'second'
    })
  })

  it('claims an outstanding reply within the TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const tracker = new TerminalQueryOwnerTracker(() => 'orb')
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 0, rawEndSeq: 4 })

    vi.advanceTimersByTime(TERMINAL_QUERY_OUTSTANDING_TTL_MS - 1)
    expect(tracker.claimReplyOwner('\x1b[12;34R')).toEqual({ matched: true, owner: 'orb' })
  })

  it('expires a stale CPR claim so Shift-F3 is no longer consumed after the owner exits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const tracker = new TerminalQueryOwnerTracker(() => 'orb')
    tracker.accept({ data: '\x1b[6n', rawStartSeq: 0, rawEndSeq: 4 })

    vi.advanceTimersByTime(TERMINAL_QUERY_OUTSTANDING_TTL_MS + 1)
    expect(tracker.claimReplyOwner('\x1b[1;2R')).toEqual({ matched: false })
  })
})
