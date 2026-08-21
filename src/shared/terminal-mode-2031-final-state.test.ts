// Why: fish enables and disables DEC mode 2031 around every prompt
// (`src/tty_handoff.rs`), so a single PTY chunk routinely carries
// `?2031h ... ?2031l`. Answering the sticky "an h appeared" flag replies to a
// subscription the shell has already dropped, and the reply lands as literal
// text at the prompt or in a child's stdin (#9993).
import { describe, expect, it } from 'vitest'
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  scanMode2031ReplyDecision,
  scanMode2031Sequences,
  type Mode2031ReplyDecision
} from './terminal-color-scheme-protocol'
import {
  createTerminalTitleTracker,
  type TerminalTitleTrackerCallbacks
} from './terminal-output-side-effects'

const ESC = '\x1b'
const BEL = '\x07'

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

/**
 * Real chunk boundaries captured from fish 4.7.1 over node-pty
 * (tests/tools/fish-mode2031-repro/capture-fish-mode2031-trace.mjs). One prompt-accept:
 * arm 2031 while painting the prompt, echo the typed line, withdraw 2031, exec the command.
 * Measured gap between chunks 1 and 4 in that trace: 0.57ms — shorter than a renderer IPC hop.
 */
const FISH_PROMPT_ACCEPT_CHUNKS: readonly string[] = [
  // 1. Prompt setup: capability probes plus the 2031 arm. Ends SUBSCRIBED.
  `${ESC}]0;~/orca${BEL}${ESC}[m${ESC}]11;?${ESC}\\${ESC}[6n${ESC}[0c${ESC}[?2004h${ESC}[?2031h${ESC}[>4;1m${ESC}=`,
  // 2. The prompt itself.
  `${ESC}]133;A;click_events=1${BEL}~/orca ❯ ${ESC}]133;B${BEL}${ESC}[K\r${ESC}[9C`,
  // 3. Echo of the typed command.
  `npx${ESC}[12C -y${ESC}[15C`,
  // 4. Accept: fish withdraws 2031 before handing the tty over. Ends UNSUBSCRIBED.
  `${ESC}[?2004l${ESC}[?2031l${ESC}[>4;0m${ESC}>\r${ESC}[15C`,
  // 5. The command is now running and owns the tty — any reply from chunk 1 lands HERE.
  `${ESC}[m${ESC}]133;C;cmdline_url=npx${BEL}`
]

function trackerRecordingBothFacts(): {
  facts: string[]
  tracker: ReturnType<typeof createTerminalTitleTracker>
} {
  const facts: string[] = []
  return {
    facts,
    tracker: createTerminalTitleTracker({
      onMode2031Subscribe: () => facts.push('2031-subscribe'),
      onMode2031Unsubscribe: () => facts.push('2031-unsubscribe')
    })
  }
}

describe('a fish prompt-accept burst is tracked, never answered (#9993)', () => {
  it('yields registry transitions only — subscribe then unsubscribe, two chunks apart', () => {
    let state = INITIAL_MODE_2031_REPLY_SCAN_STATE
    const decisions: Mode2031ReplyDecision[] = FISH_PROMPT_ACCEPT_CHUNKS.map((chunk) => {
      const result = scanMode2031ReplyDecision(state, chunk)
      state = result.state
      return result.decision
    })

    expect(decisions).toEqual(['subscribed', null, null, 'unsubscribed', null])
    // The subscription is already retired one chunk before the command starts, so a reply
    // queued on the 'subscribed' decision cannot reach fish — only the child that replaced it.
    expect(decisions.indexOf('unsubscribed')).toBeLessThan(FISH_PROMPT_ACCEPT_CHUNKS.length - 1)
  })

  it('still emits both side-effect facts so the subscription registry stays truthful', () => {
    const recorded = trackerRecordingBothFacts()

    for (const chunk of FISH_PROMPT_ACCEPT_CHUNKS) {
      recorded.tracker.handleChunk(chunk)
    }

    // Facts survive the fix: maybePushMode2031Flip needs them to know who is listening.
    expect(recorded.facts).toEqual(['2031-subscribe', '2031-unsubscribe'])
  })

  it('contains no color-scheme query, so silence is the whole correct answer', () => {
    const burst = FISH_PROMPT_ACCEPT_CHUNKS.join('')

    // Verified over a full real session: fish never sends the protocol's query (`CSI ?996n`).
    // It only ever subscribes, so there is nothing here that a `CSI ?997;Nn` could be a reply to.
    expect(burst).toContain(`${ESC}[?2031h`)
    expect(burst).not.toContain('996')
    expect(burst).not.toContain('997')
  })
})
