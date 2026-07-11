// Why: slice 3 of terminal-side-effect-authority.md adds OSC 133;D
// command-finished and GitHub pr-link scanning to the shared tracker so main
// emits those facts for local/SSH PTYs. These tests pin the chunk-boundary
// carry, exit-code best-effort, dedupe, and synthetic-frame isolation rules.
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
    ...overrides
  })
  return { events, tracker }
}

describe('createTerminalTitleTracker command-finished facts', () => {
  it('emits command-finished with best-effort exit codes', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`before${ESC}]133;A${BEL}prompt${ESC}]133;B${BEL}`)
    tracker.handleChunk(`${ESC}]133;C${BEL}running${ESC}]133;D;0${BEL}`)
    tracker.handleChunk(`${ESC}]133;D;130${BEL}`)
    tracker.handleChunk(`${ESC}]133;D;not-a-number${BEL}`)
    tracker.handleChunk(`${ESC}]133;D${BEL}`)

    expect(events).toEqual([
      ['finished', 0],
      ['finished', 130],
      ['finished', null],
      ['finished', null]
    ])
  })

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

  it('orders chunk facts titles → command-finished → bell', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}]0;zsh${BEL}${ESC}]133;D;0${BEL}done${BEL}`)

    expect(events).toEqual([['title', 'zsh'], ['finished', 0], ['bell']])
  })
})

describe('createTerminalTitleTracker pr-link facts', () => {
  it('emits one fact per PR URL including multiple links in one chunk', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(
      'see https://github.com/acme/orca/pull/42 and https://github.com/acme/orca/pull/43 \r\n'
    )

    expect(events).toEqual([
      ['pr', 'https://github.com/acme/orca/pull/42', 42],
      ['pr', 'https://github.com/acme/orca/pull/43', 43]
    ])
  })

  it('waits for a boundary when a URL splits across chunks and dedupes repeats', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk('PR: https://github.com/acme/orca/pull/4')
    expect(events).toEqual([])
    tracker.handleChunk('2\r\n')
    tracker.handleChunk('again https://github.com/acme/orca/pull/42\r\n')

    expect(events).toEqual([['pr', 'https://github.com/acme/orca/pull/42', 42]])
  })

  it('skips the 133/URL scans entirely when no consumer is registered', () => {
    // Mirrors headless serve: no pty:sideEffect consumer means no callbacks,
    // so the scanners must not be created (no carry state, no scan cost).
    const titles: string[] = []
    const tracker = createTerminalTitleTracker({
      onTitle: (normalized) => titles.push(normalized)
    })

    tracker.handleChunk(`${ESC}]133;D;0${BEL}https://github.com/acme/orca/pull/42\r\n`)

    expect(titles).toEqual([])
  })
})

describe('createTerminalTitleTracker 2031-subscribe facts', () => {
  it('emits a fact per chunk containing a DECSET 2031 subscribe, before the bell', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}[?2031hready${BEL}`)

    expect(events).toEqual([['2031-subscribe'], ['bell']])
  })

  it('detects a subscribe split across chunk boundaries', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}[?20`)
    tracker.handleChunk('31h')

    expect(events).toEqual([['2031-subscribe']])
  })

  it('ignores DECSET 2031 unsubscribes', () => {
    const { events, tracker } = createRecordingTracker()

    tracker.handleChunk(`${ESC}[?2031l`)

    expect(events).toEqual([])
  })

  it('skips the 2031 scan entirely when no consumer is registered', () => {
    const { events, tracker } = createRecordingTracker({ onMode2031Subscribe: undefined })

    tracker.handleChunk(`${ESC}[?2031h`)

    expect(events).toEqual([])
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

    // The OSC terminator (and everything after) is lost in a delivery gap
    // while scanning is suppressed.
    tracker.handleChunk(`${ESC}]0;my long title without terminator`)
    tracker.setTransientFactScanningSuppressed(true)
    tracker.setTransientFactScanningSuppressed(false)
    // Post-gap: a real standalone bell. A stale "inside OSC" state would
    // swallow it.
    tracker.handleChunk(`done${BEL}`)

    expect(events).toEqual([['bell']])
  })

  it('a handoff scan seed re-primes a split sequence so its fact fires once, without a phantom bell', () => {
    const { events, tracker } = createRecordingTracker()

    // The 133 intro was consumed before scan authority moved away; the carry
    // is reset on un-suppress. The transport hands back the emulator's
    // partial escape tail as a seed, so the continuation completes normally:
    // one command-finished, and its terminator BEL is NOT a standalone bell.
    tracker.handleChunk(`out${ESC}]133;D;`)
    tracker.setTransientFactScanningSuppressed(true)
    tracker.setTransientFactScanningSuppressed(false)
    tracker.handleChunk(`${ESC}]133;D;`, { titleScanData: '' })
    tracker.handleChunk(`130${BEL}`)

    expect(events).toEqual([['finished', 130]])
  })
})
