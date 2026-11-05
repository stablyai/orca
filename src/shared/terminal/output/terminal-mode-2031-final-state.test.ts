// fish toggles 2031 around each prompt, often in one chunk. Acting on any subscribe instead of final state sends replies into the shell/child (#9993).
import { describe, expect, it } from 'vitest'

import {
  createTerminalTitleTracker,
  type TerminalTitleTrackerCallbacks
} from './terminal-output-side-effects'

const ESC = '\x1b'
const BEL = '\x07'

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
  it('does not answer a subscribe whose withdrawal straddles the chunk boundary', () => {
    const recorded = trackerRecording()

    // A kernel split during withdrawal must hold the decision; an already-sent reply cannot be recalled.
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

/** Real fish 4.7.1/node-pty prompt-accept boundaries; capture-fish-mode2031-trace.mjs records arm → paint → echo → withdraw → exec.
 * Chunks 1–4 span 0.57ms, less than a renderer IPC hop. */
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
  it('still emits both side-effect facts so the subscription registry stays truthful', () => {
    const recorded = trackerRecordingBothFacts()

    for (const chunk of FISH_PROMPT_ACCEPT_CHUNKS) {
      recorded.tracker.handleChunk(chunk)
    }

    // Facts survive the fix: maybePushMode2031Flip needs them to know who is listening.
    expect(recorded.facts).toEqual(['2031-subscribe', '2031-unsubscribe'])
  })
})
