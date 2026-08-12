import { parseTerminalKittyKeyboardFlags } from './terminal-kitty-keyboard-flags'

// Why: PTY/SSH chunks can split an escape sequence before its final byte.
// Keep parser state far beyond normal sequence lengths while bounding memory.
const KITTY_SCAN_TAIL_LIMIT = 4096

// Why: mirrors xterm's InputHandler cap so a runaway TUI cannot grow the
// mirrored stacks unboundedly while the renderer's own stacks stay at 16.
const KITTY_STACK_LIMIT = 16

/** A pushed flags slot plus whether the value it will restore was ever proven. */
type KittyStackFrame = { flags: number; known: boolean }

/**
 * Mirrors the kitty keyboard protocol flag state (CSI > u push, CSI < u pop,
 * CSI = u set) by scanning the raw PTY output stream, replicating xterm's
 * exact stack/screen algorithm including the per-screen flag slots swapped by
 * DECSET/DECRST 47/1047/1049, the full reset on RIS, and the soft reset on
 * DECSTR (CSI ! p).
 *
 * Why a mirror instead of reading xterm's internal state: Orca defensively
 * wipes the renderer terminal's kitty flags at moments when the TUI may have
 * died (Ctrl+C interrupts, reattach resets) while the TUI is usually still
 * alive and expecting protocol-encoded input. This tracker is fed only by
 * application output, so it reflects what the *application* negotiated,
 * independent of renderer-side defensive writes. The daemon reuses it to
 * carry flags into snapshots (xterm's SerializeAddon does not serialize kitty
 * state).
 */
export class TerminalKittyKeyboardModeTracker {
  private scanTail = ''
  private currentFlags = 0
  private mainFlags = 0
  private altFlags = 0
  private currentKnown = true
  private mainKnown = true
  private altKnown = true
  private mainStack: KittyStackFrame[] = []
  private altStack: KittyStackFrame[] = []
  /** False once a snapshot replaced state whose push history was never observed. */
  private mainStackComplete = true
  private altStackComplete = true
  private alternateScreenActive = false
  private alternateScreenSwitchObserved = false
  // Why: a constructor-fresh tracker reports known-inactive, which is correct
  // for a PTY it watches from spawn but was never proven for a pre-existing
  // one. Grounding flips on evidence only: an explicit fresh-PTY reset, a
  // proven snapshot restore, or scanned bytes that state flags absolutely.
  private baselineProven = false

  /**
   * Current effective kitty keyboard flags. `0` doubles as the conservative
   * input fallback while the state is unknown — read `snapshotFlags` instead
   * when the caller must distinguish "proven inactive" from "unproven".
   */
  get flags(): number {
    return this.currentFlags
  }

  /**
   * Active screen's proven flags, absent when unknown: after snapshots without
   * Kitty metadata, or transitions needing uncarried push history. Serializers
   * publish this, never `flags` — silence must not become a proven zero.
   */
  get snapshotFlags(): number | undefined {
    return this.currentKnown ? this.currentFlags : undefined
  }

  /**
   * True once this tracker's knownness is grounded in evidence for the PTY it
   * mirrors. Consumers use it to refuse to preserve (or carry) a constructor
   * default across a snapshot that proves nothing — the fresh known-zero must
   * not be laundered into a host-proven inactive protocol.
   */
  get hasProvenBaseline(): boolean {
    return this.baselineProven
  }

  get isAlternateScreen(): boolean {
    return this.alternateScreenActive
  }

  get hasObservedAlternateScreenSwitch(): boolean {
    return this.alternateScreenSwitchObserved
  }

  /** Full reset to a fresh PTY: known-inactive on both screens. */
  reset(): void {
    this.baselineProven = true
    this.scanTail = ''
    this.currentFlags = 0
    this.mainFlags = 0
    this.altFlags = 0
    this.currentKnown = true
    this.mainKnown = true
    this.altKnown = true
    this.mainStack = []
    this.altStack = []
    this.mainStackComplete = true
    this.altStackComplete = true
    this.alternateScreenActive = false
    this.alternateScreenSwitchObserved = false
  }

  /**
   * Start applying a replacement or historical snapshot. Production snapshot
   * ANSI deliberately omits kitty pushes, so scanning it can never recover a
   * negotiation that predates the capture: keep `0` as the input fallback but
   * mark both screens and their stacks unproven until `restoreSnapshotFlags`
   * or explicit application output proves them again.
   */
  resetForSnapshot(): void {
    this.reset()
    this.baselineProven = false
    this.currentKnown = false
    this.mainKnown = false
    this.altKnown = false
    this.mainStackComplete = false
    this.altStackComplete = false
  }

  /**
   * Adopt the effective flags the snapshot owner proved at the snapshot's own
   * sequence boundary. Only the ACTIVE screen becomes known — the inactive
   * screen's slot and both push stacks stay unproven because current snapshot
   * authorities expose neither.
   */
  restoreSnapshotFlags(flags: number): void {
    const parsed = parseTerminalKittyKeyboardFlags(flags)
    if (parsed === undefined) {
      return
    }
    this.currentFlags = parsed
    this.currentKnown = true
    this.baselineProven = true
  }

  scan(data: string): void {
    this.scanInternal(data, false)
  }

  /**
   * Scan bytes replayed from a retained history window (reattach payloads,
   * relay replays, daemon snapshots). Replays can redeliver the application's
   * one-time CSI > u push — applying it with stack semantics on every delivery
   * grows the mirrored stack, so the TUI's eventual single pop lands on a
   * stale frame and Option chords stay kitty-encoded in a plain shell. Pushes
   * seen during replay therefore apply as idempotent sets. Known limit: a
   * NESTED push/push/pop inside the window collapses to flags 0 on the pop —
   * unavoidable stackless-replay tradeoff (a redelivered push is byte-wise
   * indistinguishable from a new one); real TUIs push once at startup.
   */
  scanReplay(data: string): void {
    this.scanInternal(data, true)
  }

  private scanInternal(data: string, replay: boolean): void {
    const input = this.scanTail + data
    this.scanTail = this.extractScanTail(input)
    // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
    const kittyModeRe = /\x1bc|(?:\x1b\[|\x9b)(?:!p|\?([0-9;]+)([hl])|([<>=])([0-9;]*)u)/g
    let match: RegExpExecArray | null
    while ((match = kittyModeRe.exec(input)) !== null) {
      if (match[0] === '\x1bc') {
        // RIS resets kitty state and returns to the main screen.
        const tail = this.scanTail
        this.reset()
        this.scanTail = tail
        this.alternateScreenSwitchObserved = true
        continue
      }
      if (match[0].endsWith('!p')) {
        this.applySoftReset()
        continue
      }
      if (match[1] !== undefined) {
        this.applyScreenSwitch(match[1], match[2] === 'h')
        continue
      }
      this.applyKittySequence(match[3], match[4] ?? '', replay)
    }
  }

  private applySoftReset(): void {
    // Why: xterm's DECSTR (CSI ! p) wipes kitty flags and stacks for both
    // screens via coreService.reset but does not switch buffers — mirror that
    // so a soft-resetting TUI stops receiving kitty-encoded Option chords.
    this.baselineProven = true
    this.currentFlags = 0
    this.mainFlags = 0
    this.altFlags = 0
    this.currentKnown = true
    this.mainKnown = true
    this.altKnown = true
    this.mainStack = []
    this.altStack = []
    this.mainStackComplete = true
    this.altStackComplete = true
  }

  private applyScreenSwitch(params: string, enabled: boolean): void {
    for (const rawParam of params.split(';')) {
      const param = Number(rawParam)
      if (param !== 47 && param !== 1047 && param !== 1049) {
        continue
      }
      this.alternateScreenSwitchObserved = true
      // Why: xterm swaps the current flags with the inactive screen's slot on
      // every 47/1047/1049 transition, without an already-active guard —
      // mirror it exactly so this state matches what the renderer encodes.
      // Why the known bit rides the numeric slot: a screen whose flags were
      // never proven must not become proven just by being swapped in.
      if (enabled) {
        this.mainFlags = this.currentFlags
        this.mainKnown = this.currentKnown
        this.currentFlags = this.altFlags
        this.currentKnown = this.altKnown
        this.alternateScreenActive = true
      } else {
        this.altFlags = this.currentFlags
        this.altKnown = this.currentKnown
        this.currentFlags = this.mainFlags
        this.currentKnown = this.mainKnown
        this.alternateScreenActive = false
      }
    }
  }

  private applyKittySequence(prefix: string, params: string, replay: boolean): void {
    const parsed = params.split(';').map((entry) => Number(entry))
    const stack = this.alternateScreenActive ? this.altStack : this.mainStack
    if (prefix === '>') {
      if (!replay) {
        if (stack.length >= KITTY_STACK_LIMIT) {
          stack.shift()
        }
        stack.push({ flags: this.currentFlags, known: this.currentKnown })
      }
      // A push states the new effective flags absolutely, so they are proven
      // even when the value it displaced was not.
      this.currentFlags = parsed[0] || 0
      this.currentKnown = true
      this.baselineProven = true
      return
    }
    if (prefix === '<') {
      const count = Math.max(1, parsed[0] || 1)
      let lastPopped: KittyStackFrame | null = null
      for (let i = 0; i < count; i++) {
        const frame = stack.pop()
        if (!frame) {
          lastPopped = null
          break
        }
        lastPopped = frame
        this.currentFlags = frame.flags
        this.currentKnown = frame.known
      }
      if (stack.length === 0) {
        // Why: xterm zeroes an exhausted stack even over a just-popped value.
        // With complete history that matches the app's emulator exactly, but a
        // mirror whose stack omits pre-snapshot pushes empties EARLIER than
        // the app's — its forced zero is only proven when the popped frame
        // itself proves 0 (the app restores that same value whatever sits
        // below it); landing at empty on any other frame, or past it, proves
        // nothing about the older history.
        this.currentFlags = 0
        const stackComplete = this.alternateScreenActive
          ? this.altStackComplete
          : this.mainStackComplete
        this.currentKnown =
          stackComplete || (lastPopped !== null && lastPopped.known && lastPopped.flags === 0)
      }
      return
    }
    const flags = parsed[0] || 0
    const mode = parsed.length > 1 && parsed[1] ? parsed[1] : 1
    if (mode === 1) {
      // An absolute set re-proves the active screen regardless of its baseline.
      this.currentFlags = flags
      this.currentKnown = true
      this.baselineProven = true
    } else if (mode === 2) {
      // Relative updates only preserve knowledge; they cannot create it.
      this.currentFlags |= flags
    } else if (mode === 3) {
      this.currentFlags &= ~flags
    }
  }

  private extractScanTail(input: string): string {
    const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'))
    if (start === -1) {
      return ''
    }
    const tail = input.slice(start)
    if (tail.length > KITTY_SCAN_TAIL_LIMIT) {
      return ''
    }
    if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') {
      return tail
    }
    const body = tail.startsWith('\x1b[')
      ? tail.slice(2)
      : tail.startsWith('\x9b')
        ? tail.slice(1)
        : null
    if (body === null) {
      return ''
    }
    return this.isIncompleteSequenceBody(body) ? tail : ''
  }

  private isIncompleteSequenceBody(body: string): boolean {
    return body === '!' || /^[<>=?]?[0-9;]*$/.test(body)
  }
}
