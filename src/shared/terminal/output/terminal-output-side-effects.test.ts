// Pin shared OSC 133/PR-link carry, best-effort exit codes, dedupe and isolation from synthetic frames.
import { describe, expect, it } from 'vitest'
import {
  createTerminalTitleTracker,
  type TerminalTitleTrackerCallbacks
} from './terminal-output-side-effects'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

type RecordedEvent =
  | ['title', string]
  | ['bell']
  | ['finished', number | null]
  | ['pr', string, number]
  | ['2031-subscribe']
  | ['2031-unsubscribe']

function createRecordingTracker(overrides: TerminalTitleTrackerCallbacks = {}): {
  events: RecordedEvent[]
  tracker: ReturnType<typeof createTerminalTitleTracker>
} {
  const events: RecordedEvent[] = []
  const tracker = createTerminalTitleTracker({
    onTitle: (normalized) => events.push(['title', normalized]),
    onBell: () => events.push(['bell']),
    onCommandFinished: (exitCode) => events.push(['finished', exitCode]),
    onPrLink: (link) => events.push(['pr', link.url, link.number]),
    onMode2031Subscribe: () => events.push(['2031-subscribe']),
    onMode2031Unsubscribe: () => events.push(['2031-unsubscribe']),
    ...overrides
  })
  return { events, tracker }
}

describe('createTerminalTitleTracker command-finished facts', () => {
  it('detects OSC 133;D split across chunk boundaries (BEL and ST terminated)', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`chunk${ESC}]133`)
    tracker.handleChunk(';D;1')
    expect(events).toEqual([])
    tracker.handleChunk(`30${BEL}rest`)
    tracker.handleChunk(`${ESC}]133;D;7${ST}`)

    expect(events).toEqual([
      ['finished', 130],
      ['finished', 7]
    ])
  })

  it('reports command starts in byte order with command finishes', () => {
    const events: string[] = []
    const tracker = createTerminalTitleTracker({
      onCommandStarted: () => events.push('started'),
      onCommandFinished: (exitCode) => events.push(`finished:${exitCode}`)
    })

    tracker.handleChunk(`${ESC}]133;C${BEL}running${ESC}]133;D;0${BEL}${ESC}]13`)
    tracker.handleChunk(`3;C${BEL}`)

    expect(events).toEqual(['started', 'finished:0', 'started'])
  })

  it('orders chunk facts titles → command-finished → bell', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}]0;zsh${BEL}${ESC}]133;D;0${BEL}done${BEL}`)

    expect(events).toEqual([['title', 'zsh'], ['finished', 0], ['bell']])
  })
})

describe('createTerminalTitleTracker pr-link facts', () => {
  it('waits for a boundary when a URL splits across chunks and dedupes repeats', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk('PR: https://github.com/acme/orca/pull/4')
    expect(events).toEqual([])
    tracker.handleChunk('2\r\n')
    tracker.handleChunk('again https://github.com/acme/orca/pull/42\r\n')

    expect(events).toEqual([['pr', 'https://github.com/acme/orca/pull/42', 42]])
  })
})

describe('createTerminalTitleTracker 2031-subscribe facts', () => {
  it('emits a fact per chunk containing a DECSET 2031 subscribe, before the bell', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}[?2031hready${BEL}`)

    expect(events).toEqual([['2031-subscribe'], ['bell']])
  })

  it('reports only the chunk-final state when a chunk toggles 2031 both ways', () => {
    // fish enables and disables 2031 around every prompt; one chunk, one decision.
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}[?2031hprompt${ESC}[?2031l`)
    tracker.handleChunk(`${ESC}[?2031lprompt${ESC}[?2031h`)

    expect(events).toEqual([['2031-unsubscribe'], ['2031-subscribe']])
  })
})

describe('createTerminalTitleTracker synthetic-frame isolation', () => {
  it('never feeds synthetic frames to the 133/PR scanners', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.applySyntheticTitleFrame(
      `${ESC}]0;⠋ Cursor Agent${BEL}${ESC}]133;D;0${BEL}https://github.com/acme/orca/pull/42\r\n`
    )

    expect(events).toEqual([['title', '⠋ Cursor Agent']])
  })

  it('keeps a split 133 carry intact across an interleaved synthetic frame', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`out${ESC}]133;D;`)
    // An 80ms spinner tick lands between the two halves of the real OSC.
    tracker.applySyntheticTitleFrame(`${ESC}]0;⠋ Cursor Agent${BEL}`)
    tracker.handleChunk(`130${BEL}`)

    expect(events).toEqual([
      ['title', '⠋ Cursor Agent'],
      ['finished', 130]
    ])
  })
})

describe('createTerminalTitleTracker transient-fact scanning suppression', () => {
  it('skips bell/133/pr-link/2031 while suppressed but keeps title processing', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.setTransientFactScanningSuppressed(true)
    tracker.handleChunk(
      `${ESC}]0;zsh${BEL}${ESC}]133;D;0${BEL}ding${BEL}https://github.com/acme/orca/pull/42\r\n${ESC}[?2031h`
    )

    expect(events).toEqual([['title', 'zsh']])
  })

  it('resets cross-chunk carry on un-suppress so a pre-gap half-open OSC cannot swallow bells', () => {
    const { events, tracker } = createRecordingTracker()

    // A suppressed delivery gap loses the title terminator.
    tracker.handleChunk(`${ESC}]0;my long title without terminator`)
    tracker.setTransientFactScanningSuppressed(true)
    tracker.setTransientFactScanningSuppressed(false)
    // Reset OSC state or this real bell would be swallowed.
    tracker.handleChunk(`done${BEL}`)

    expect(events).toEqual([['bell']])
  })

  it('a handoff scan seed re-primes a split sequence so its fact fires once, without a phantom bell', () => {
    const { events, tracker } = createRecordingTracker()

    // Authority returns with the emulator’s partial tail after carry reset; complete one command without ringing its terminator BEL.
    tracker.handleChunk(`out${ESC}]133;D;`)
    tracker.setTransientFactScanningSuppressed(true)
    tracker.setTransientFactScanningSuppressed(false)
    tracker.handleChunk(`${ESC}]133;D;`, { titleScanData: '' })
    tracker.handleChunk(`130${BEL}`)

    expect(events).toEqual([['finished', 130]])
  })

  it('a handoff scan seed preserves a provisional 2031 subscribe', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.setTransientFactScanningSuppressed(true)
    tracker.setTransientFactScanningSuppressed(false)
    tracker.handleChunk(`${ESC}[?`, {
      titleScanData: '',
      mode2031PendingSubscribe: true
    })
    tracker.handleChunk('25h')

    expect(events).toEqual([['2031-subscribe']])
  })
})
