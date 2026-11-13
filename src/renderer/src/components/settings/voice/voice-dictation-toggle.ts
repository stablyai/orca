import type { DeveloperPermissionRequestResult } from '../../../../../shared/developer-permissions-types'
import type { FeatureTipId } from '../../../../../shared/feature-tips'
import type { VoiceSettings } from '../../../../../shared/speech-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type VoiceDictationToggleOptions = {
  voiceEnabled: boolean
  markFeatureTipsSeen: (ids: FeatureTipId[]) => void
  updateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  requestMicrophonePermission: () => Promise<DeveloperPermissionRequestResult>
  setPermissionPending?: (pending: boolean) => void
  isMounted?: () => boolean
  notifyPermissionGranted?: () => void
  notifyPermissionOpenedSystemSettings?: () => void
  notifyPermissionRequired?: () => void
  notifyPermissionRequestFailed?: () => void
}

export async function handleVoiceDictationToggle({
  voiceEnabled,
  markFeatureTipsSeen,
  updateVoiceSettings,
  requestMicrophonePermission,
  setPermissionPending,
  isMounted,
  notifyPermissionGranted,
  notifyPermissionOpenedSystemSettings,
  notifyPermissionRequired,
  notifyPermissionRequestFailed
}: VoiceDictationToggleOptions): Promise<void> {
  // Toggling proves discovery; later disabling must not make the introduction eligible again.
  markFeatureTipsSeen(['voice-dictation'])

  if (voiceEnabled) {
    updateVoiceSettings({ enabled: false })
    return
  }

  setPermissionPending?.(true)
  try {
    // Request the microphone when dictation is enabled, before a first recording can fail.
    const result = await requestMicrophonePermission()
    if (result.status === 'granted' || result.status === 'unsupported') {
      updateVoiceSettings({ enabled: true })
    }

    if (result.status === 'granted') {
      notifyPermissionGranted?.()
    } else if (result.openedSystemSettings) {
      notifyPermissionOpenedSystemSettings?.()
    } else if (result.status !== 'unsupported') {
      notifyPermissionRequired?.()
    }
  } catch {
    notifyPermissionRequestFailed?.()
  } finally {
    if (isMounted?.() ?? true) {
      setPermissionPending?.(false)
    }
  }
}

/** The toasts the Voice pane shows for each microphone permission outcome. */
export const voiceDictationPermissionToasts = {
  notifyPermissionGranted: () =>
    toast.success(
      translate('auto.components.settings.VoicePane.cd9fe37556', 'Microphone permission granted')
    ),
  notifyPermissionOpenedSystemSettings: () =>
    toast.message(
      translate(
        'auto.components.settings.VoicePane.1eac933202',
        'Opened macOS Privacy & Security. Enable dictation again after granting access.'
      )
    ),
  notifyPermissionRequired: () =>
    toast.message(
      translate(
        'auto.components.settings.VoicePane.f9a9cf6928',
        'Microphone permission is required before enabling voice dictation.'
      )
    ),
  notifyPermissionRequestFailed: () =>
    toast.error(
      translate(
        'auto.components.settings.VoicePane.ad5d036ecc',
        'Could not request microphone permission. Voice dictation was not enabled.'
      )
    )
}
