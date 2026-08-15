import { describe, expect, it } from 'vitest'
import { TerminalQueryOwnerTracker } from './terminal-query-owner'

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
})
