import { useState } from 'react'
import { toast } from 'sonner'
import type { SpeechModelProvider, VoiceSettings } from '../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'

type CloudProvider = Exclude<SpeechModelProvider, 'local'>

type Args = {
  provider: CloudProvider
  currentModelId: string
  selectedProvider: SpeechModelProvider | undefined
  updateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  refreshModelStates: () => Promise<void>
  isMounted: () => boolean
}

type ProviderConfig = {
  saveKey: (draft: string) => Promise<unknown>
  clearKey: () => Promise<unknown>
  configuredSettings: (configured: boolean) => Partial<VoiceSettings>
  savedMessage: [string, string]
  saveFailedMessage: [string, string]
  clearedMessage: [string, string]
  clearFailedMessage: [string, string]
}

const PROVIDER_CONFIG: Record<CloudProvider, ProviderConfig> = {
  openai: {
    saveKey: (draft) => window.api.speech.saveOpenAiApiKey(draft),
    clearKey: () => window.api.speech.clearOpenAiApiKey(),
    configuredSettings: (configured) => ({ openAiApiKeyConfigured: configured }),
    savedMessage: ['auto.components.settings.VoicePane.506df81ba6', 'OpenAI API key saved'],
    saveFailedMessage: [
      'auto.components.settings.VoicePane.8572bbb537',
      'Failed to save OpenAI API key'
    ],
    clearedMessage: ['auto.components.settings.VoicePane.37aba8bb63', 'OpenAI API key cleared'],
    clearFailedMessage: [
      'auto.components.settings.VoicePane.62d2a84d31',
      'Failed to clear OpenAI API key'
    ]
  },
  soniox: {
    saveKey: (draft) => window.api.speech.saveSonioxApiKey(draft),
    clearKey: () => window.api.speech.clearSonioxApiKey(),
    configuredSettings: (configured) => ({ sonioxApiKeyConfigured: configured }),
    savedMessage: ['auto.components.settings.VoicePane.5b719fb45d', 'Soniox API key saved'],
    saveFailedMessage: [
      'auto.components.settings.VoicePane.c41bdf8a4d',
      'Failed to save Soniox API key'
    ],
    clearedMessage: ['auto.components.settings.VoicePane.9a6f01c227', 'Soniox API key cleared'],
    clearFailedMessage: [
      'auto.components.settings.VoicePane.a4121e3bfd',
      'Failed to clear Soniox API key'
    ]
  }
}

export function useSpeechApiKeySettings({
  provider,
  currentModelId,
  selectedProvider,
  updateVoiceSettings,
  refreshModelStates,
  isMounted
}: Args) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [pendingModelId, setPendingModelId] = useState<string | null>(null)
  const config = PROVIDER_CONFIG[provider]

  const openDialog = (modelId: string | null = null): void => {
    setPendingModelId(modelId)
    setDraft('')
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    setPending(true)
    try {
      await config.saveKey(draft)
      updateVoiceSettings({
        ...config.configuredSettings(true),
        sttModel: pendingModelId ?? currentModelId
      })
      await refreshModelStates()
      if (isMounted()) {
        setOpen(false)
        setDraft('')
        setPendingModelId(null)
      }
      toast.success(translate(...config.savedMessage))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : translate(...config.saveFailedMessage))
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }

  const clear = async (): Promise<void> => {
    setPending(true)
    try {
      await config.clearKey()
      updateVoiceSettings({
        ...config.configuredSettings(false),
        sttModel: selectedProvider === provider ? '' : currentModelId
      })
      await refreshModelStates()
      if (isMounted()) {
        setOpen(false)
        setDraft('')
        setPendingModelId(null)
      }
      toast.success(translate(...config.clearedMessage))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : translate(...config.clearFailedMessage))
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }

  return { open, setOpen, draft, setDraft, pending, openDialog, save, clear }
}
