// Why: PTY/SSH chunks can split an escape sequence before its final byte.
// Keep parser state far beyond normal sequence lengths while bounding memory.
const KITTY_SCAN_TAIL_LIMIT = 4096

// Why: mirrors xterm's InputHandler cap so a runaway TUI cannot grow the
// mirrored stacks unboundedly while the renderer's own stacks stay at 16.
const KITTY_STACK_LIMIT = 16

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
  private mainStack: number[] = []
  private altStack: number[] = []
  private alternateScreenActive = false
  private alternateScreenSwitchObserved = false

  /** Current effective kitty keyboard flags (0 = protocol inactive). */
  get flags(): number {
    return this.currentFlags
  }

  get isAlternateScreen(): boolean {
    return this.alternateScreenActive
  }

  get hasObservedAlternateScreenSwitch(): boolean {
    return this.alternateScreenSwitchObserved
  }

  reset(): void {
    this.scanTail = ''
    this.currentFlags = 0
    this.mainFlags = 0
    this.altFlags = 0
    this.mainStack = []
    this.altStack = []
    this.alternateScreenActive = false
    this.alternateScreenSwitchObserved = false
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
    this.currentFlags = 0
    this.mainFlags = 0
    this.altFlags = 0
    this.mainStack = []
    this.altStack = []
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
      if (enabled) {
        this.mainFlags = this.currentFlags
        this.currentFlags = this.altFlags
        this.alternateScreenActive = true
      } else {
        this.altFlags = this.currentFlags
        this.currentFlags = this.mainFlags
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
        stack.push(this.currentFlags)
      }
      this.currentFlags = parsed[0] || 0
      return
    }
    if (prefix === '<') {
      const count = Math.max(1, parsed[0] || 1)
      for (let i = 0; i < count && stack.length > 0; i++) {
        this.currentFlags = stack.pop() as number
      }
      if (stack.length === 0) {
        this.currentFlags = 0
      }
      return
    }
    const flags = parsed[0] || 0
    const mode = parsed.length > 1 && parsed[1] ? parsed[1] : 1
    if (mode === 1) {
      this.currentFlags = flags
    } else if (mode === 2) {
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
