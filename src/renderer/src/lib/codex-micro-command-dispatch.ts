import type { CodexMicroSettings } from '../../../shared/codex-micro-settings'
import type { CodexMicroInputEvent } from '../../../shared/codex-micro-types'
import { dispatchAppCommand } from './app-command-dispatch'

export function dispatchCodexMicroInput(
  event: CodexMicroInputEvent,
  settings: CodexMicroSettings
): boolean {
  if (!settings.enabled || event.kind !== 'control') {
    return false
  }
  // The wide microphone key emits ACT10 and ACT11 together.
  if (event.control === 'ACT11') {
    return false
  }
  const isEncoderStep = event.control === 'ENC_CC' || event.control === 'ENC_CW'
  if (isEncoderStep ? event.action !== 2 : event.action !== 1) {
    return false
  }
  const actionId = settings.mappings[event.control]
  return actionId ? dispatchAppCommand(actionId, 'codex-micro') : false
}
