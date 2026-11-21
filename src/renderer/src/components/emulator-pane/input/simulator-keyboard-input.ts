import {
  buildServeSimKeyboardFramesForCode,
  buildServeSimKeyboardFramesForKey,
  type ServeSimKeyboardFrame
} from '../../../../../shared/emulator/emulator-keyboard-frame'

export type SimulatorKeyPress = {
  alt: boolean
  /** Caps Lock capitalized a character; the guest has no Caps Lock state of its own. */
  capsLetter: boolean
  code: string
  key: string
  shift: boolean
}

// Synced simulators take the physical key; unsynced ones keep a US layout, so the character picks its US key.
export function simulatorKeyFrames(
  press: SimulatorKeyPress,
  physicalKeys: boolean
): ServeSimKeyboardFrame[] | null {
  if (physicalKeys) {
    return buildServeSimKeyboardFramesForCode(press.code, {
      alt: press.alt,
      shift: press.shift || press.capsLetter
    })
  }
  // Option composes characters only through the guest's own layout.
  return press.alt ? null : buildServeSimKeyboardFramesForKey(press.key, { shift: press.shift })
}

// `layout` is the layout sync a key was typed under; held past a later one, its physical key may
// type something else.
type HeldInput =
  | { kind: 'key'; press: SimulatorKeyPress; layout: number }
  | { kind: 'text'; text: string }

export type HeldSimulatorInputSinks = {
  /** The key's frames under the simulator's current layout, or null when it has no key for it. */
  keyFrames: (press: SimulatorKeyPress) => ServeSimKeyboardFrame[] | null
  /** Sends frames spaced out; returns ms until the last one goes, or null when none went. */
  sendFrames: (frames: ServeSimKeyboardFrame[]) => number | null
  /** Types committed text through main; later input waits until it settles. */
  typeText: (text: string) => Promise<unknown>
}

export type SimulatorKeyPressOutcome = 'sent' | 'held' | 'unsupported'

// Named keys (Enter, Dead, F1) are one capitalized word; anything else, combining marks
// included, is the character the key typed.
function isPrintable(key: string): boolean {
  return key.length > 0 && !/^[A-Z][A-Za-z0-9]+$/.test(key)
}

/**
 * Keeps simulator keys and committed text in typing order. Keys go straight to the HID socket
 * unless a layout sync or a text commit is in flight; then they wait behind it. Text waits for
 * the spaced frames of keys sent before it, since it reaches the simulator another way.
 */
export class HeldSimulatorInput {
  private held: HeldInput[] = []
  private syncing = false
  private typing = false
  private generation = 0
  private layout = 0
  private framesDoneAt = 0
  // Set while keys wait for earlier frames still going out; a new key's first frame would pass them.
  private framesTimer: ReturnType<typeof setTimeout> | null = null
  // The latest sinks; release after an async commit uses them.
  private sinks: HeldSimulatorInputSinks | null = null

  get holding(): boolean {
    return this.syncing || this.typing || this.framesTimer !== null
  }

  /** A layout sync is in flight, so the simulator's layout is not known yet. */
  get syncingLayout(): boolean {
    return this.syncing
  }

  /** `unsupported` means nothing was sent or held, so the host's own text input should take it. */
  pressKey(press: SimulatorKeyPress, sinks: HeldSimulatorInputSinks): SimulatorKeyPressOutcome {
    this.sinks = sinks
    if (!this.holding && Date.now() < this.framesDoneAt) {
      this.waitForFrames()
    }
    if (this.holding) {
      this.held.push({ kind: 'key', press, layout: this.layout })
      return 'held'
    }
    const frames = sinks.keyFrames(press)
    return frames && this.send(frames, sinks) ? 'sent' : 'unsupported'
  }

  commitText(text: string, sinks: HeldSimulatorInputSinks): void {
    this.sinks = sinks
    if (this.holding) {
      this.holdText(text)
      return
    }
    this.type(text)
  }

  startSync(): void {
    this.syncing = true
    this.layout += 1
  }

  finishSync(sinks: HeldSimulatorInputSinks): void {
    this.sinks = sinks
    this.syncing = false
    this.release()
  }

  /** Drops held input so nothing typed in one capture (or pane) lands in a later one. */
  clear(): void {
    this.generation += 1
    this.held = []
    this.syncing = false
    this.typing = false
    this.framesDoneAt = 0
    if (this.framesTimer !== null) {
      clearTimeout(this.framesTimer)
      this.framesTimer = null
    }
  }

  private waitForFrames(): void {
    const generation = this.generation
    this.framesTimer = setTimeout(() => {
      this.framesTimer = null
      if (generation === this.generation) {
        this.release()
      }
    }, this.framesDoneAt - Date.now())
  }

  // Commits typed back to back while one is in flight go as one, not one subprocess each.
  private holdText(text: string): void {
    const last = this.held.at(-1)
    if (last?.kind === 'text') {
      last.text += text
    } else {
      this.held.push({ kind: 'text', text })
    }
  }

  private send(frames: ServeSimKeyboardFrame[], sinks: HeldSimulatorInputSinks): boolean {
    const lastFrameInMs = sinks.sendFrames(frames)
    if (lastFrameInMs === null) {
      return false
    }
    this.framesDoneAt = Math.max(this.framesDoneAt, Date.now() + lastFrameInMs)
    return true
  }

  private type(text: string): void {
    const sinks = this.sinks
    if (!sinks) {
      return
    }
    this.typing = true
    const generation = this.generation
    const start = (): unknown => (generation === this.generation ? sinks.typeText(text) : undefined)
    const wait = this.framesDoneAt - Date.now()
    const typed =
      wait > 0
        ? new Promise((resolve) => setTimeout(resolve, wait)).then(start)
        : new Promise((resolve) => resolve(start()))
    void typed
      .catch(() => undefined)
      .then(() => {
        if (generation === this.generation) {
          this.typing = false
          this.release()
        }
      })
  }

  // A held key whose layout changed since, or that the simulator has no key for, types as text.
  private heldKeyFrames(
    item: HeldInput & { kind: 'key' },
    sinks: HeldSimulatorInputSinks
  ): ServeSimKeyboardFrame[] | null {
    return isPrintable(item.press.key) && item.layout !== this.layout
      ? null
      : sinks.keyFrames(item.press)
  }

  private release(): void {
    const sinks = this.sinks
    if (this.holding || !sinks) {
      return
    }
    const frames: ServeSimKeyboardFrame[] = []
    let text = ''
    for (let item = this.held[0]; item; item = this.held[0]) {
      if (item.kind === 'text') {
        text += item.text
      } else {
        const keyFrames = this.heldKeyFrames(item, sinks)
        if (keyFrames) {
          // Keys after text wait for it.
          if (text) {
            break
          }
          frames.push(...keyFrames)
        } else if (isPrintable(item.press.key)) {
          text += item.press.key
        }
      }
      this.held.shift()
    }
    // One call keeps the released keys' spaced frames in order.
    if (frames.length > 0) {
      this.send(frames, sinks)
    }
    if (text) {
      this.type(text)
    }
  }
}
