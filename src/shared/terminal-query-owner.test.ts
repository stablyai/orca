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
})
