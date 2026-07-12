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

  const openDialog = (modelId: string | null = null): void => {
    setPendingModelId(modelId)
    setDraft('')
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    setPending(true)
    try {
      if (provider === 'openai') {
        await window.api.speech.saveOpenAiApiKey(draft)
        updateVoiceSettings({
          openAiApiKeyConfigured: true,
          sttModel: pendingModelId ?? currentModelId
        })
      } else {
        await window.api.speech.saveSonioxApiKey(draft)
        updateVoiceSettings({
          sonioxApiKeyConfigured: true,
          sttModel: pendingModelId ?? currentModelId
        })
      }
      await refreshModelStates()
      if (isMounted()) {
        setOpen(false)
        setDraft('')
        setPendingModelId(null)
      }
      toast.success(
        provider === 'openai'
          ? translate('auto.components.settings.VoicePane.506df81ba6', 'OpenAI API key saved')
          : translate('auto.components.settings.VoicePane.sonioxKeySaved', 'Soniox API key saved')
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : provider === 'openai'
            ? translate(
                'auto.components.settings.VoicePane.8572bbb537',
                'Failed to save OpenAI API key'
              )
            : translate(
                'auto.components.settings.VoicePane.sonioxKeySaveFailed',
                'Failed to save Soniox API key'
              )
      )
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }

  const clear = async (): Promise<void> => {
    setPending(true)
    try {
      if (provider === 'openai') {
        await window.api.speech.clearOpenAiApiKey()
        updateVoiceSettings({
          openAiApiKeyConfigured: false,
          sttModel: selectedProvider === provider ? '' : currentModelId
        })
      } else {
        await window.api.speech.clearSonioxApiKey()
        updateVoiceSettings({
          sonioxApiKeyConfigured: false,
          sttModel: selectedProvider === provider ? '' : currentModelId
        })
      }
      await refreshModelStates()
      if (isMounted()) {
        setOpen(false)
        setDraft('')
        setPendingModelId(null)
      }
      toast.success(
        provider === 'openai'
          ? translate('auto.components.settings.VoicePane.37aba8bb63', 'OpenAI API key cleared')
          : translate(
              'auto.components.settings.VoicePane.sonioxKeyCleared',
              'Soniox API key cleared'
            )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : provider === 'openai'
            ? translate(
                'auto.components.settings.VoicePane.62d2a84d31',
                'Failed to clear OpenAI API key'
              )
            : translate(
                'auto.components.settings.VoicePane.sonioxKeyClearFailed',
                'Failed to clear Soniox API key'
              )
      )
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }

  return { open, setOpen, draft, setDraft, pending, openDialog, save, clear }
}
