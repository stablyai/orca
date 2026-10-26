export const DICTATION_CONTROL_EVENT = 'dictation:control'

/** Dictation started with no text field focused; the pane that owns typing focuses its input. */
export const DICTATION_FOCUS_INPUT_EVENT = 'dictation:focusInput'

export type DictationControlAction = 'toggle' | 'start' | 'stop'

export function dispatchDictationControl(
  action: DictationControlAction,
  conversationTarget?: Element
): void {
  document.dispatchEvent(
    new CustomEvent(DICTATION_CONTROL_EVENT, {
      detail: conversationTarget ? { action, conversationTarget } : action
    })
  )
}
