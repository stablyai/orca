import { ownRetainedString } from './own-retained-string'
import { parseTerminalKittyKeyboardFlags } from './terminal-kitty-keyboard-flags'

// Carry split PTY/SSH escapes while bounding malformed streams.
const KITTY_SCAN_TAIL_LIMIT = 4096

// Match xterm’s InputHandler stack cap so the mirror cannot outgrow the renderer.
const KITTY_STACK_LIMIT = 16

/** A pushed flags slot plus whether the value it will restore was ever proven. */
type KittyStackFrame = { flags: number; known: boolean }

/** Mirror xterm’s exact per-screen flags/stacks, 47/1047/1049 swaps, RIS and DECSTR; the public API exposes no Kitty flags.
 * Renderer writes reassert the mirror after skipped/discarded bytes; daemon snapshots need it because SerializeAddon omits Kitty state. */
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
  // Constructor zero proves nothing for an existing PTY; ground only on fresh-PTY reset, proven snapshot or absolute mode output.
  private baselineProven = false
  // modifyOtherKeys gates the same keys when apps such as pi fall back after an unanswered Kitty query.
  private modifyOtherKeysState = 0
  private readonly kittyKeyboard: boolean

  /** `kittyKeyboard: false` mirrors an xterm with the protocol withheld, which ignores `CSI u`. */
  constructor(options: { kittyKeyboard?: boolean } = {}) {
    this.kittyKeyboard = options.kittyKeyboard ?? true
  }

  /** Effective input flags; 0 is also the unknown-state fallback. Use snapshotFlags when proof matters. */
  get flags(): number {
    return this.currentFlags
  }

  /** Publish only proven active-screen flags; snapshots/transitions with missing history must not become known zero. */
  get snapshotFlags(): number | undefined {
    return this.currentKnown ? this.currentFlags : undefined
  }

  /** Evidence grounds the baseline for this PTY; consumers must not carry constructor defaults through unproven snapshots. */
  get hasProvenBaseline(): boolean {
    return this.baselineProven
  }

  /** Last XTMODKEYS level the app set for modifyOtherKeys; 0 when off or never set. */
  get modifyOtherKeys(): number {
    return this.modifyOtherKeysState
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
    this.modifyOtherKeysState = 0
  }

  /** Snapshots omit Kitty pushes. Mark screens/stacks unproven until snapshot metadata or absolute application output proves flags again. */
  resetForSnapshot(): void {
    // Older snapshots cannot restate modifyOtherKeys; clear dead-app state at shell/process boundaries instead.
    const modifyOtherKeys = this.modifyOtherKeysState
    this.reset()
    this.modifyOtherKeysState = modifyOtherKeys
    this.baselineProven = false
    this.currentKnown = false
    this.mainKnown = false
    this.altKnown = false
    this.mainStackComplete = false
    this.altStackComplete = false
  }

  /** Adopt flags proven at the snapshot sequence boundary; inactive-screen state and push histories remain unknown. */
  restoreSnapshotFlags(flags: number): void {
    const parsed = parseTerminalKittyKeyboardFlags(flags)
    if (parsed === undefined || !this.kittyKeyboard) {
      return
    }
    this.currentFlags = parsed
    this.currentKnown = true
    this.baselineProven = true
  }

  /** Scan snapshot screen selection before owner-proven flags; only demote when the owner supplies evidence, preserving live-tracked state for older hosts. */
  adoptSnapshot(snapshotData: string, provenFlags: number | undefined): void {
    // Fresh mirrors’ initial zero proves nothing about reattached PTYs; demote it before downstream serialization can claim known-inactive flags.
    if (provenFlags !== undefined || !this.baselineProven) {
      this.resetForSnapshot()
    }
    this.scanReplay(snapshotData)
    if (provenFlags !== undefined) {
      this.restoreSnapshotFlags(provenFlags)
    }
  }

  scan(data: string): void {
    this.scanInternal(data, false)
  }

  /** Replayed one-time pushes act as idempotent sets so reconnects cannot grow stacks and strand Option chords in Kitty mode.
   * Stackless replay loses nested push/push/pop history (pop yields 0); repeated and new pushes are byte-identical. */
  scanReplay(data: string): void {
    this.scanInternal(data, true)
  }

  private scanInternal(data: string, replay: boolean): void {
    // Why: unchecked main-process callers can pass a snapshot field that is absent.
    const chunk = typeof data === 'string' ? data : ''
    if (this.scanTail.length === 0 && !chunk.includes('\x1b') && !chunk.includes('\x9b')) {
      return
    }
    const input = this.scanTail + chunk
    this.scanTail = this.extractScanTail(input)
    const kittyModeRe =
      // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
      /\x1bc|(?:\x1b\[|\x9b)(?:!p|\?([0-9;]+)([hl])|([<>=])([0-9;]*)u|>4(?:;([0-9]*))?m)/g
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
      if (match[3] === undefined) {
        // `CSI > 4 m` and `CSI > 4 ; m` both reset the resource to 0.
        this.modifyOtherKeysState = Number(match[5] ?? '') || 0
        continue
      }
      if (this.kittyKeyboard) {
        this.applyKittySequence(match[3], match[4] ?? '', replay)
      }
    }
  }

  private applySoftReset(): void {
    // Mirror DECSTR: clear both screens’ Kitty flags/stacks without switching buffers.
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
      // Mirror xterm’s unconditional 47/1047/1049 slot swaps, including repeated enables/disables; carry proof with each numeric slot.
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
      // A push proves its new absolute flags even when the displaced flags were unknown.
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
        // xterm forces zero on exhaustion. Missing pre-snapshot history can exhaust the mirror early;
        // prove zero only from complete history or a popped frame that itself proves zero.
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
    return this.isIncompleteSequenceBody(body) ? ownRetainedString(tail) : ''
  }

  private isIncompleteSequenceBody(body: string): boolean {
    return body === '!' || /^[<>=?]?[0-9;]*$/.test(body)
  }
}
