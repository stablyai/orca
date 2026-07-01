import { useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import type { SpeechModelProvider, VoiceSettings } from '../../../../shared/speech-types'

type CloudApiKeyConfiguredField = 'openAiApiKeyConfigured' | 'sarvamApiKeyConfigured'

type CloudApiKeyProviderConfig = {
  // The provider whose selected model should be reset when its key is cleared.
  provider: Extract<SpeechModelProvider, 'openai' | 'sarvam'>
  configuredField: CloudApiKeyConfiguredField
  saveKey: (apiKey: string) => Promise<unknown>
  clearKey: () => Promise<unknown>
  messages: {
    saved: string
    saveFailed: string
    cleared: string
    clearFailed: string
  }
}

type CloudApiKeyActionsDeps = {
  updateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  refreshModelStates: () => Promise<void> | void
  mountedRef: MutableRefObject<boolean>
  currentSttModel: string
  // Provider of the currently selected model, used to decide whether clearing a
  // key must also deselect the active model.
  selectedProvider: SpeechModelProvider | undefined
  pendingCloudModelId: string | null
  setPendingCloudModelId: (modelId: string | null) => void
}

export type CloudApiKeyActions = {
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
  apiKeyDraft: string
  setApiKeyDraft: (value: string) => void
  pending: boolean
  openDialog: (modelId?: string | null) => void
  save: () => Promise<void>
  clear: () => Promise<void>
}

// Consolidates the identical save/clear/dialog lifecycle every cloud STT
// provider needs, so adding a provider is a config change rather than another
// copy of the same ~60 lines of state juggling.
export function useCloudApiKeyActions(
  config: CloudApiKeyProviderConfig,
  deps: CloudApiKeyActionsDeps
): CloudApiKeyActions {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [pending, setPending] = useState(false)

  const openDialog = (modelId: string | null = null): void => {
    deps.setPendingCloudModelId(modelId)
    setApiKeyDraft('')
    setDialogOpen(true)
  }

  const resetAfterMutation = (): void => {
    setDialogOpen(false)
    setApiKeyDraft('')
    deps.setPendingCloudModelId(null)
  }

  const save = async (): Promise<void> => {
    setPending(true)
    try {
      await config.saveKey(apiKeyDraft)
      const updates: Partial<VoiceSettings> = {
        sttModel: deps.pendingCloudModelId ?? deps.currentSttModel
      }
      updates[config.configuredField] = true
      deps.updateVoiceSettings(updates)
      await deps.refreshModelStates()
      resetAfterMutation()
      toast.success(config.messages.saved)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : config.messages.saveFailed)
    } finally {
      if (deps.mountedRef.current) {
        setPending(false)
      }
    }
  }

  const clear = async (): Promise<void> => {
    setPending(true)
    try {
      await config.clearKey()
      const updates: Partial<VoiceSettings> = {
        // Why: dropping the key makes the active cloud model unusable, so clear
        // the selection when it belongs to this provider.
        sttModel: deps.selectedProvider === config.provider ? '' : deps.currentSttModel
      }
      updates[config.configuredField] = false
      deps.updateVoiceSettings(updates)
      await deps.refreshModelStates()
      resetAfterMutation()
      toast.success(config.messages.cleared)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : config.messages.clearFailed)
    } finally {
      if (deps.mountedRef.current) {
        setPending(false)
      }
    }
  }

  return {
    dialogOpen,
    setDialogOpen,
    apiKeyDraft,
    setApiKeyDraft,
    pending,
    openDialog,
    save,
    clear
  }
}
