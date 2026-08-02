import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import type { VoiceSettings } from '../../../../shared/speech-types'

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
  // Why: changing the Voice Dictation switch proves the user discovered the
  // feature; disabling it later should not make the discovery modal eligible.
  markFeatureTipsSeen(['voice-dictation'])

  if (voiceEnabled) {
    updateVoiceSettings({ enabled: false })
    return
  }

  setPermissionPending?.(true)
  try {
    // Why: enabling dictation is the point where users expect the macOS
    // microphone prompt, not after their first attempted recording fails.
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
