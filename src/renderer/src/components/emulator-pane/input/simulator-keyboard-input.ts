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

type HeldInput = { kind: 'key'; press: SimulatorKeyPress } | { kind: 'text'; text: string }

export type HeldSimulatorInputSinks = {
  /** Sends key presses typed in a row; one call keeps their spaced frames in order. */
  sendKeys: (presses: SimulatorKeyPress[]) => void
  /** Types committed IME text through main; later input waits until it settles. */
  typeText: (text: string) => Promise<unknown>
}

/**
 * Keeps simulator keys and committed IME text in typing order. Keys go straight to the HID socket
 * unless a layout sync or a text commit is in flight; then they wait behind it.
 */
export class HeldSimulatorInput {
  private held: HeldInput[] = []
  private syncing = false
  private typing = false
  private generation = 0
  // The latest render's sinks; release after an async commit uses them.
  private sinks: HeldSimulatorInputSinks | null = null

  get holding(): boolean {
    return this.syncing || this.typing
  }

  /** Returns false when the key was not held, so the caller sends it now. */
  holdKey(press: SimulatorKeyPress): boolean {
    if (!this.holding) {
      return false
    }
    this.held.push({ kind: 'key', press })
    return true
  }

  commitText(text: string, sinks: HeldSimulatorInputSinks): void {
    this.sinks = sinks
    if (this.holding) {
      // Commits typed back to back while one is in flight go as one, not one subprocess each.
      const last = this.held.at(-1)
      if (last?.kind === 'text') {
        last.text += text
      } else {
        this.held.push({ kind: 'text', text })
      }
      return
    }
    this.type(text)
  }

  startSync(): void {
    this.syncing = true
  }

  finishSync(sinks: HeldSimulatorInputSinks): void {
    this.sinks = sinks
    this.syncing = false
    this.release()
  }

  /** Drops held input so nothing typed in one capture lands in a later one. */
  clear(): void {
    this.generation += 1
    this.held = []
    this.syncing = false
    this.typing = false
  }

  private type(text: string): void {
    const sinks = this.sinks
    if (!sinks) {
      return
    }
    this.typing = true
    const generation = this.generation
    void sinks
      .typeText(text)
      .catch(() => undefined)
      .then(() => {
        if (generation === this.generation) {
          this.typing = false
          this.release()
        }
      })
  }

  private release(): void {
    const sinks = this.sinks
    if (this.holding || !sinks) {
      return
    }
    const held = this.held
    this.held = []
    const presses: SimulatorKeyPress[] = []
    for (const [index, item] of held.entries()) {
      if (item.kind === 'key') {
        presses.push(item.press)
        continue
      }
      if (presses.length > 0) {
        sinks.sendKeys(presses)
      }
      this.held = held.slice(index + 1)
      this.type(item.text)
      return
    }
    if (presses.length > 0) {
      sinks.sendKeys(presses)
    }
  }
}
