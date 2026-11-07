import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { hostDictationErrorMessage } from '../../../../shared/host-dictation-error-messages'
import { SPEECH_MODEL_NEEDS_UPDATE_ERROR } from '../../../../shared/speech-model-retirement'

function openVoiceSettingsAction(): { label: string; onClick: () => void } {
  return {
    label: translate('auto.components.dictation.DictationController.bb7f599ee7', 'Open Settings'),
    onClick: () => {
      useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
      useAppStore.getState().openSettingsPage()
    }
  }
}

export function showDictationNoModelToast(): void {
  toast(
    translate(
      'auto.components.dictation.DictationController.noModel',
      'No speech model selected. Download one in Settings > Voice.'
    ),
    // Held keys and repeated presses replace this toast instead of stacking it.
    { id: 'dictation-no-model', action: openVoiceSettingsAction() }
  )
}

export function showDictationDisabledToast(): void {
  toast(
    translate(
      'auto.components.dictation.DictationController.disabled',
      'Voice dictation is disabled. Enable it in Settings > Voice.'
    ),
    { action: openVoiceSettingsAction() }
  )
}

export function showMicrophoneFallbackToast(): void {
  toast.message(
    translate(
      'auto.components.dictation.DictationController.micFallback',
      'Selected microphone unavailable. Using system default.'
    )
  )
}

/** The host keeps what was said up to its cap, so the caller stops normally to insert it. */
export function showCloudLimitToast(): void {
  toast.message(
    translate(
      'auto.components.dictation.DictationController.cloudLimitReached',
      'Dictation stopped at the 10-minute cloud limit.'
    )
  )
}

export function showMicrophoneDisconnectedToast(): void {
  toast.message(
    translate(
      'auto.components.dictation.DictationController.micDisconnected',
      'Microphone disconnected. Dictation stopped.'
    )
  )
}

export function showDictationStartErrorToast(message: string): void {
  // A paired web client rejects with the host's bare code, which String(error) prefixes with "Error: ".
  const detail = compactIpcErrorMessage(message)?.replace(/^Error:\s*/, '') ?? ''
  const hostMessage = hostDictationErrorMessage(detail)
  if (hostMessage) {
    toast.error(hostMessage)
  } else if (message.includes('Permission') || message.includes('NotAllowed')) {
    toast.error(
      translate(
        'auto.components.dictation.DictationController.2d5b9fabf9',
        'Microphone access denied. Grant access in system settings, then restart Orca.'
      )
    )
  } else if (message.includes(SPEECH_MODEL_NEEDS_UPDATE_ERROR)) {
    toast(
      translate(
        'auto.components.dictation.DictationController.modelNeedsUpdate',
        'Your speech model needs an update to keep working. Update it to the faster version in Settings > Voice.'
      ),
      { action: openVoiceSettingsAction() }
    )
  } else if (message.includes('not ready') || detail.startsWith('voice_model_not_ready')) {
    toast(
      translate(
        'auto.components.dictation.DictationController.notReady',
        'Speech model not ready. Download it in Settings > Voice.'
      ),
      { action: openVoiceSettingsAction() }
    )
  } else if (message.includes('Unknown model')) {
    toast(
      translate(
        'auto.components.dictation.DictationController.unknownModel',
        'Selected model is no longer available. Please choose another in Settings > Voice.'
      ),
      { action: openVoiceSettingsAction() }
    )
  } else {
    toast.error(
      translate(
        'auto.components.dictation.DictationController.55127a3706',
        'Dictation failed: {{value0}}',
        {
          value0: message
        }
      )
    )
  }
}
