import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './tui-agent-config'

// PTY mode resets end the agent's current input region and revoke readiness seen before them.
// oxlint-disable-next-line no-control-regex -- the handoff bytes are escape sequences.
const HANDOFF = /\x1b\[\?(?:2004|2031|1049)l/g
const HANDOFF_CARRY_CHARS = 7
const TAIL_CHARS = 8 * 1024
// Cursor-forward (CUF) and column (CHA) moves: how agents paint the gaps between words.
// oxlint-disable-next-line no-control-regex -- escape sequences.
const HORIZONTAL_MOVE = /\x1b\[\d*[CG]/g

export type GeneratedInputObservationFeed = {
  /** Output after subscription; may resolve its dispose asynchronously. */
  observe: (onData: (data: string) => void) => (() => void) | Promise<() => void>
  /** Output the terminal produced before this subscription (startup bytes a replay keeps). */
  replay?: () => string | undefined
}

/** What one operation saw of its terminal's output since it began: the readiness scanner, the quiet
 *  clock, and the text since the last handoff. It lives as long as the operation, whatever the
 *  intent, so a dialog streamed while the operation queues or writes is still seen. */
export class GeneratedInputObservation {
  private scanner
  private carry = ''
  private tailText = ''
  private replaying = true
  private readonly pending: string[] = []
  private dispose: (() => void) | undefined
  private closed = false
  /** Output count; a startup signal refused once is asked again only after new output. */
  sequence = 0
  lastOutput = Date.now()
  ready = false
  quietArmed = false
  graceAt: number | null = null

  constructor(
    private readonly signal: DraftPasteReadySignal,
    private readonly onOutput: () => void
  ) {
    this.scanner = createDraftPasteReadyScanner(signal)
  }

  /** Starts observing; resolves once the replay is applied, rejects when observation is unavailable. */
  async start(feed: GeneratedInputObservationFeed): Promise<void> {
    const dispose = await feed.observe((data) => {
      this.lastOutput = Date.now()
      this.sequence += 1
      if (this.replaying) {
        this.pending.push(data)
        return
      }
      this.scan(data)
      this.onOutput()
    })
    if (this.closed) {
      dispose()
      return
    }
    this.dispose = dispose
    this.lastOutput = Date.now()
    const replay = feed.replay?.()
    if (replay) {
      this.scan(replay)
    }
    for (const data of this.pending.splice(0)) {
      this.scan(data)
    }
    this.replaying = false
  }

  close(): void {
    this.closed = true
    this.dispose?.()
    this.dispose = undefined
  }

  /** Plain text streamed since the last handoff, bounded; veto and marker evidence, never a grid. */
  get tail(): string {
    return this.tailText
  }

  /** The startup marker or its structural grace has been seen since the last handoff. */
  signalled(now = Date.now()): boolean {
    return this.ready || (this.graceAt !== null && now >= this.graceAt)
  }

  private scan(data: string): void {
    const combined = this.carry + data
    this.carry = combined.slice(-HANDOFF_CARRY_CHARS)
    const last = [...combined.matchAll(HANDOFF)].at(-1)
    if (last) {
      this.scanner = createDraftPasteReadyScanner(this.signal)
      this.ready = false
      this.quietArmed = false
      this.graceAt = null
      this.tailText = ''
      data = combined.slice(last.index + last[0].length)
    }
    // Word gaps painted as cursor moves stay gaps, so prompts and key hints read as text.
    const spaced = data.replace(HORIZONTAL_MOVE, ' ')
    const text = stripAnsiEscapeSequences(spaced).replace(/\r\n?/g, '\n')
    this.tailText = (this.tailText + text).slice(-TAIL_CHARS)
    const result = this.scanner.observe(data)
    this.ready ||= result.ready
    this.quietArmed ||= result.armQuietTimer
    if (result.readyAfterMs === null) {
      this.graceAt = null
    } else if (result.readyAfterMs !== undefined) {
      this.graceAt ??= Date.now() + result.readyAfterMs
    }
  }
}
