export const VOICE_CONTROL_ACTION_EVENT = 'voice-control:control'

export type VoiceControlAction = 'toggle' | 'start' | 'stop'

export function dispatchVoiceControlAction(action: VoiceControlAction): void {
  document.dispatchEvent(
    new CustomEvent<VoiceControlAction>(VOICE_CONTROL_ACTION_EVENT, { detail: action })
  )
}
