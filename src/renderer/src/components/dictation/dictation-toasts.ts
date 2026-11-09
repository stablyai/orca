import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { hostDictationErrorMessage } from '../../../../shared/host-dictation-error-messages'

export function openVoiceSettings(): void {
  useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
  useAppStore.getState().openSettingsPage()
}

function openVoiceSettingsAction(): { label: string; onClick: () => void } {
  return {
    label: translate('auto.components.dictation.DictationController.bb7f599ee7', 'Open Settings'),
    onClick: openVoiceSettings
  }
}

type DictationStartError = 'host' | 'microphone' | 'model-not-ready' | 'unknown-model' | 'other'

function classifyDictationStartError(message: string): {
  kind: DictationStartError
  detail: string
} {
  // A paired web client rejects with the host's bare code, which String(error) prefixes with "Error: ".
  const detail = compactIpcErrorMessage(message)?.replace(/^Error:\s*/, '') ?? ''
  const kind: DictationStartError = hostDictationErrorMessage(detail)
    ? 'host'
    : message.includes('Permission') || message.includes('NotAllowed')
      ? 'microphone'
      : message.includes('not ready') || detail.startsWith('voice_model_not_ready')
        ? 'model-not-ready'
        : message.includes('Unknown model')
          ? 'unknown-model'
          : 'other'
  return { kind, detail }
}

/** `settings` failures offer Open settings beside Retry. */
export type DictationFailureKind = 'settings' | 'transcribe'

/** A start that failed after recording began is a model that couldn't load; null keeps the toast. */
export function dictationStartFailureKind(message: string): DictationFailureKind | null {
  const { kind } = classifyDictationStartError(message)
  // Main's macOS mic check fails before any audio could be transcribed.
  if (kind === 'host' || kind === 'microphone' || message.includes('Microphone access')) {
    return null
  }
  return 'settings'
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

export function showRetryOverlapUnmatchedToast(): void {
  toast.message(
    translate(
      'auto.components.dictation.DictationController.retryUnmatched',
      "Retry couldn't tell which words were already typed, so it inserted them all."
    )
  )
}

export function showNoSpeechDetectedToast(): void {
  toast.message(
    translate('auto.components.dictation.DictationController.5d2c3e7ae3', 'No speech detected.')
  )
}

export function showSpeechErrorToast(error: string): void {
  toast.error(
    translate(
      'auto.components.dictation.DictationController.de136f1199',
      'Speech error: {{value0}}',
      {
        value0: error
      }
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
  const { kind, detail } = classifyDictationStartError(message)
  const hostMessage = hostDictationErrorMessage(detail)
  if (hostMessage) {
    toast.error(hostMessage)
  } else if (kind === 'microphone') {
    toast.error(
      translate(
        'auto.components.dictation.DictationController.2d5b9fabf9',
        'Microphone access denied. Grant access in system settings, then restart Orca.'
      )
    )
  } else if (kind === 'model-not-ready') {
    toast(
      translate(
        'auto.components.dictation.DictationController.notReady',
        'Speech model not ready. Download it in Settings > Voice.'
      ),
      { action: openVoiceSettingsAction() }
    )
  } else if (kind === 'unknown-model') {
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
