import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

function openVoiceSettings(): void {
  useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
  useAppStore.getState().openSettingsPage()
}

export function showDictationStartErrorToast(message: string): void {
  if (message.includes('Permission') || message.includes('NotAllowed')) {
    toast.error(
      translate(
        'auto.components.dictation.DictationController.2d5b9fabf9',
        'Microphone access denied. Grant access in system settings, then restart Orca.'
      )
    )
  } else if (message.includes('not ready')) {
    toast('Speech model not ready. Download it in Settings > Voice.')
  } else if (message.includes('Unknown model')) {
    toast('Selected model is no longer available. Please choose another in Settings > Voice.', {
      action: {
        label: translate(
          'auto.components.dictation.DictationController.bb7f599ee7',
          'Open Settings'
        ),
        onClick: openVoiceSettings
      }
    })
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
