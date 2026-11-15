export const KEYBOARD_LAYOUT_CHANGED_CHANNEL = 'app:keyboardLayoutChanged'

export type KeyboardLayoutChangeEvent = {
  phase: 'invalidated' | 'refresh'
  generation: number
}
