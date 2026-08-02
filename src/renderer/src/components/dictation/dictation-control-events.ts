export const DICTATION_CONTROL_EVENT = 'dictation:control'

export type DictationControlAction = 'toggle' | 'start' | 'stop'

export function dispatchDictationControl(action: DictationControlAction): void {
  document.dispatchEvent(
    new CustomEvent<DictationControlAction>(DICTATION_CONTROL_EVENT, { detail: action })
  )
}
