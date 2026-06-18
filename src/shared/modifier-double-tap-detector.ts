import type { PhysicalModifierToken } from './keybindings'

// Why: max gap between the first release and the second press. Internal — not
// user-configurable — and tight enough that normal fast typing never triggers.
const DOUBLE_TAP_WINDOW_MS = 300

export type ModifierDoubleTapEventType = 'keyDown' | 'keyUp'

// A keyboard event normalized to just what the detector needs.
export type ModifierDoubleTapEvent = {
  type: ModifierDoubleTapEventType
  // Which physical modifier this event is about, or null for any other key.
  modifier: PhysicalModifierToken | null
  // True only for a bare modifier press/release with no OTHER modifier held.
  isModifierOnly: boolean
  isAutoRepeat: boolean
}

export type DetectedDoubleTap = { modifier: PhysicalModifierToken }

export type ModifierKeyEventLike = {
  type: ModifierDoubleTapEventType
  code?: string
  key?: string
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
  isAutoRepeat?: boolean
}

const MODIFIER_BY_CODE: Record<string, PhysicalModifierToken> = {
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Cmd',
  MetaRight: 'Cmd'
}

const MODIFIER_BY_KEY: Record<string, PhysicalModifierToken> = {
  Shift: 'Shift',
  Control: 'Ctrl',
  Alt: 'Alt',
  Meta: 'Cmd'
}

// Maps a physical key event to the modifier it represents, or null for any
// non-modifier key. Detector output is always a physical token (never 'Mod').
export function modifierFromKeyEvent(
  code: string | undefined,
  key: string | undefined
): PhysicalModifierToken | null {
  if (code && MODIFIER_BY_CODE[code]) {
    return MODIFIER_BY_CODE[code]
  }
  return key ? (MODIFIER_BY_KEY[key] ?? null) : null
}

function otherModifierHeld(event: ModifierKeyEventLike, modifier: PhysicalModifierToken): boolean {
  if (modifier !== 'Shift' && event.shift) {
    return true
  }
  if (modifier !== 'Ctrl' && event.control) {
    return true
  }
  if (modifier !== 'Alt' && event.alt) {
    return true
  }
  if (modifier !== 'Cmd' && event.meta) {
    return true
  }
  return false
}

// Normalizes a platform key event (DOM or Electron) into the detector input.
export function toModifierDoubleTapEvent(event: ModifierKeyEventLike): ModifierDoubleTapEvent {
  const modifier = modifierFromKeyEvent(event.code, event.key)
  return {
    type: event.type,
    modifier,
    isModifierOnly: modifier !== null && !otherModifierHeld(event, modifier),
    isAutoRepeat: Boolean(event.isAutoRepeat)
  }
}

type DetectorState =
  | { phase: 'idle' }
  | { phase: 'down1'; modifier: PhysicalModifierToken }
  | { phase: 'armed'; modifier: PhysicalModifierToken; deadlineMs: number }

export class ModifierDoubleTapDetector {
  private state: DetectorState = { phase: 'idle' }

  process(event: ModifierDoubleTapEvent, timestampMs: number): DetectedDoubleTap | null {
    // A non-modifier key, or a modifier chorded with another, breaks the gesture.
    // (On keyUp, isModifierOnly:false means another modifier is still held — the
    // gesture was already reset at that modifier's keyDown.)
    if (event.modifier === null || !event.isModifierOnly) {
      this.state = { phase: 'idle' }
      return null
    }
    if (event.type === 'keyUp') {
      this.onModifierUp(event.modifier, timestampMs)
      return null
    }
    return this.onModifierDown(event.modifier, event.isAutoRepeat, timestampMs)
  }

  reset(): void {
    this.state = { phase: 'idle' }
  }

  private onModifierDown(
    modifier: PhysicalModifierToken,
    isAutoRepeat: boolean,
    timestampMs: number
  ): DetectedDoubleTap | null {
    if (
      this.state.phase === 'armed' &&
      this.state.modifier === modifier &&
      !isAutoRepeat &&
      timestampMs <= this.state.deadlineMs
    ) {
      this.state = { phase: 'idle' }
      return { modifier }
    }
    // Auto-repeat means the key is being held, not tapped.
    if (isAutoRepeat) {
      this.state = { phase: 'idle' }
      return null
    }
    // Any other fresh bare-modifier press (re)starts from the first tap.
    this.state = { phase: 'down1', modifier }
    return null
  }

  private onModifierUp(modifier: PhysicalModifierToken, timestampMs: number): void {
    if (this.state.phase === 'down1' && this.state.modifier === modifier) {
      this.state = { phase: 'armed', modifier, deadlineMs: timestampMs + DOUBLE_TAP_WINDOW_MS }
      return
    }
    // Why: a keyup of the armed modifier with no intervening second keydown means
    // the second press was consumed elsewhere (the main process suppresses it for
    // an allowlisted action). Clear armed so a later lone press of the same
    // modifier can't phantom-complete a double-tap.
    if (this.state.phase === 'armed' && this.state.modifier === modifier) {
      this.state = { phase: 'idle' }
    }
  }
}
