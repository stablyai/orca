import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './agent-launch/catalog/tui-agent-config-types'

// PTY mode resets end the agent's current input region and revoke readiness seen before them.
// oxlint-disable-next-line no-control-regex -- the handoff bytes are escape sequences.
const HANDOFF = /\x1b\[\?(?:2004|2031|1049)l/g
const HANDOFF_CARRY_CHARS = 7
const TAIL_CHARS = 8 * 1024
const PENDING_CHARS = 4 * TAIL_CHARS
// A sequence longer than this is not one an agent paints; it is decoded as it stands.
const MAX_ESCAPE_CARRY = 4096
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
  // An escape sequence cut by a chunk boundary, finished by the next chunk before decoding.
  private escapeCarry = ''
  private tailText = ''
  private replaying = true
  private pending = ''
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
      if (this.closed) {
        return
      }
      this.lastOutput = Date.now()
      this.sequence += 1
      if (this.replaying) {
        // Kept in order until the replay is read. Output arriving proves the subscription is
        // live, so past the bound the replay is read now rather than any output being dropped.
        this.pending += data
        if (this.pending.length > PENDING_CHARS) {
          this.applyReplay(feed)
        }
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
    this.applyReplay(feed)
  }

  /** Output from before the subscription, then what arrived while it was set up, in order. */
  private applyReplay(feed: GeneratedInputObservationFeed): void {
    if (!this.replaying) {
      return
    }
    this.replaying = false
    const replay = feed.replay?.()
    if (replay) {
      this.scan(replay)
    }
    if (this.pending) {
      this.scan(this.pending)
      this.pending = ''
    }
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

  private forgetReadiness(): void {
    this.scanner = createDraftPasteReadyScanner(this.signal)
    this.ready = false
    this.quietArmed = false
    this.graceAt = null
  }

  /** Decodes output into the tail incrementally: an escape sequence split across chunks is
   *  completed by the next one, so a dialog's text never reaches the tail half-decoded. */
  private appendTail(data: string): void {
    let text = this.escapeCarry + data
    const cut = incompleteEscapeStart(text)
    this.escapeCarry = cut === -1 ? '' : text.slice(cut)
    if (cut !== -1) {
      text = text.slice(0, cut)
    }
    // Word gaps painted as cursor moves stay gaps, so prompts and key hints read as text.
    const decoded = stripAnsiEscapeSequences(text.replace(HORIZONTAL_MOVE, ' '))
    this.tailText = (this.tailText + decoded.replace(/\r\n?/g, '\n')).slice(-TAIL_CHARS)
  }

  private scan(data: string): void {
    const combined = this.carry + data
    this.carry = combined.slice(-HANDOFF_CARRY_CHARS)
    const last = [...combined.matchAll(HANDOFF)].at(-1)
    if (last) {
      this.forgetReadiness()
      this.tailText = ''
      this.escapeCarry = ''
      data = combined.slice(last.index + last[0].length)
    }
    this.appendTail(data)
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

/** Where an escape sequence at the end of `text` starts if it is not finished yet, else -1. */
function incompleteEscapeStart(text: string): number {
  const start = text.lastIndexOf('\x1b')
  if (start === -1 || text.length - start > MAX_ESCAPE_CARRY) {
    return -1
  }
  const kind = text[start + 1]
  if (kind === undefined) {
    return start
  }
  const body = text.slice(start + 2)
  if (kind === '[') {
    // CSI: parameter and intermediate bytes, then one final byte in @..~.
    return /^[0-?]*[ -/]*[@-~]/.test(body) ? -1 : start
  }
  if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
    // OSC/DCS/SOS/PM/APC: until BEL or ST.
    // oxlint-disable-next-line no-control-regex -- the terminators are control characters.
    return /\x07|\x1b\\/.test(body) ? -1 : start
  }
  return -1
}
