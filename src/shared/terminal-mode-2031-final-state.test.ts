// Why: fish enables and disables DEC mode 2031 around every prompt
// (`src/tty_handoff.rs`), so a single PTY chunk routinely carries
// `?2031h ... ?2031l`. Answering the sticky "an h appeared" flag replies to a
// subscription the shell has already dropped, and the reply lands as literal
// text at the prompt or in a child's stdin (#9993).
import { describe, expect, it } from 'vitest'
import { scanMode2031Sequences } from './terminal-color-scheme-protocol'
import {
  createTerminalTitleTracker,
  type TerminalTitleTrackerCallbacks
} from './terminal-output-side-effects'

const ESC = '\x1b'

// A fish prompt cycle: subscribe, paint the prompt, hand the tty to the child.
const FISH_PROMPT_HANDOFF = `${ESC}[?2031h${ESC}[0m~/orca ${ESC}[32m❯${ESC}[0m ${ESC}[?2031l`

function trackerRecording(overrides: TerminalTitleTrackerCallbacks = {}): {
  subscribes: number
  tracker: ReturnType<typeof createTerminalTitleTracker>
} {
  const state = { subscribes: 0 }
  const tracker = createTerminalTitleTracker({
    onMode2031Subscribe: () => {
      state.subscribes += 1
    },
    ...overrides
  })
  return {
    get subscribes() {
      return state.subscribes
    },
    tracker
  }
}

describe('DECSET 2031 replies follow the chunk-final state (#9993)', () => {
  it('reports a subscribe-then-unsubscribe chunk as unsubscribed', () => {
    const scan = scanMode2031Sequences('', FISH_PROMPT_HANDOFF)

    // The sticky flags stay true — both toggles really did occur.
    expect(scan.subscribe).toBe(true)
    expect(scan.unsubscribe).toBe(true)
    // But the shell is NOT listening by the end of the chunk.
    expect(scan.finalState).toBe('unsubscribed')
  })

  it('does not emit a 2031-subscribe fact when the shell unsubscribed in the same chunk', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(FISH_PROMPT_HANDOFF)

    expect(recorded.subscribes).toBe(0)
  })

  it('still emits a fact when the chunk ends subscribed', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?2031l${ESC}[?2031h`)

    expect(recorded.subscribes).toBe(1)
  })

  it('emits once per chunk that ends subscribed, across a fish prompt loop', () => {
    const recorded = trackerRecording()

    // Three prompt cycles, then a TUI that subscribes and keeps listening.
    recorded.tracker.handleChunk(FISH_PROMPT_HANDOFF)
    recorded.tracker.handleChunk(FISH_PROMPT_HANDOFF)
    recorded.tracker.handleChunk(FISH_PROMPT_HANDOFF)
    recorded.tracker.handleChunk(`${ESC}[?2031h`)

    expect(recorded.subscribes).toBe(1)
  })

  it('keeps answering a subscribe split across chunk boundaries', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?20`)
    recorded.tracker.handleChunk('31h')

    expect(recorded.subscribes).toBe(1)
  })

  it('does not answer a subscribe whose withdrawal straddles the chunk boundary', () => {
    const recorded = trackerRecording()

    // Same bytes as FISH_PROMPT_HANDOFF, just cut mid-withdrawal by the kernel.
    // A reply cannot be recalled, so chunk 1 must hold rather than answer-then-regret.
    recorded.tracker.handleChunk(`${ESC}[?2031h prompt ${ESC}[?20`)
    recorded.tracker.handleChunk('31l')

    expect(recorded.subscribes).toBe(0)
  })

  it('does not defer for a partial sequence that cannot become a private mode', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?2031h drawing ${ESC}[25`)

    expect(recorded.subscribes).toBe(1)
  })

  it('defers an unrelated private-mode prefix that can append 2031', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?2031h drawing ${ESC}[?25`)
    expect(recorded.subscribes).toBe(0)
    recorded.tracker.handleChunk(';2031l')

    expect(recorded.subscribes).toBe(0)
  })

  it('answers a deferred subscribe when the ambiguous tail resolves to another mode', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?2031h drawing ${ESC}[?20`)
    expect(recorded.subscribes).toBe(0)
    recorded.tracker.handleChunk('25h')

    expect(recorded.subscribes).toBe(1)
  })

  it('answers the re-subscribe once when a split toggle resolves back to h', () => {
    const recorded = trackerRecording()

    recorded.tracker.handleChunk(`${ESC}[?2031h p ${ESC}[?2031l${ESC}[?20`)
    recorded.tracker.handleChunk('31h')

    // Chunk 1 ends unsubscribed-then-pending, chunk 2 resolves to subscribed.
    expect(recorded.subscribes).toBe(1)
  })
})
