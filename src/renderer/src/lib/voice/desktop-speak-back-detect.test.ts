import { describe, expect, it } from 'vitest'
import { detectSpeakBackAnnouncement } from './desktop-speak-back-detect'

const base = { paneKey: 'tab-1:leaf', state: 'done' as const, lastAssistantMessage: 'all done' }

describe('detectSpeakBackAnnouncement', () => {
  it('speaks on a working→done edge', () => {
    expect(detectSpeakBackAnnouncement(base, true)).toEqual({
      paneKey: 'tab-1:leaf',
      reply: 'all done',
      dedupeKey: 'tab-1:leaf:all done'
    })
  })

  it('stays silent on a done row that was never working', () => {
    // The mutation that matters: drop the wasWorking guard and every poll of a
    // finished pane re-speaks it. This is the edge, not the level.
    expect(detectSpeakBackAnnouncement(base, false)).toBeNull()
  })

  it('does not speak waiting or blocked — neither carries a reply', () => {
    // 'waiting' = asking the operator, 'blocked' = stuck. Measured: a waiting
    // transition reports lastAssistantMessage null. Speaking these would narrate
    // an unfinished, empty turn.
    expect(detectSpeakBackAnnouncement({ ...base, state: 'waiting' }, true)).toBeNull()
    expect(detectSpeakBackAnnouncement({ ...base, state: 'blocked' }, true)).toBeNull()
  })

  it('stays silent when the finished turn has no message', () => {
    expect(
      detectSpeakBackAnnouncement({ ...base, lastAssistantMessage: '   ' }, true)
    ).toBeNull()
    expect(
      detectSpeakBackAnnouncement({ ...base, lastAssistantMessage: undefined }, true)
    ).toBeNull()
  })

  it('keys dedupe on the reply so the pane can speak its NEXT turn', () => {
    // paneKey alone would suppress every future turn from the pane. The reply
    // prefix lets a genuinely new answer through.
    const first = detectSpeakBackAnnouncement(base, true)
    const second = detectSpeakBackAnnouncement(
      { ...base, lastAssistantMessage: 'a different answer' },
      true
    )
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
  })
})
