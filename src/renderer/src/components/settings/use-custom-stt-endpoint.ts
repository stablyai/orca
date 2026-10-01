import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import type { CustomSttEndpointTestState } from './CustomSttEndpointDialog'
import { translate } from '@/i18n/i18n'

type UseCustomSttEndpointArgs = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  updateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  refreshModelStates: () => Promise<void> | void
  isMounted: () => boolean
}

const DISCOVERY_DEBOUNCE_MS = 700

/**
 * Owns the custom-endpoint dialog state and its IPC. Extracted from VoicePane so
 * the pane stays within the file-size budget and the endpoint flow is testable.
 */
export function useCustomSttEndpoint({
  voiceSettings,
  selectedModel,
  updateVoiceSettings,
  refreshModelStates,
  isMounted
}: UseCustomSttEndpointArgs): {
  dialogOpen: boolean
  baseUrlDraft: string
  modelDraft: string
  languageDraft: string
  apiKeyDraft: string
  pending: boolean
  testing: boolean
  discovering: boolean
  modelSuggestions: string[]
  testResult: CustomSttEndpointTestState | null
  setDialogOpen: (open: boolean) => void
  setBaseUrlDraft: (value: string) => void
  setModelDraft: (value: string) => void
  setLanguageDraft: (value: string) => void
  setApiKeyDraft: (value: string) => void
  openDialog: () => void
  cancel: () => void
  save: () => Promise<void>
  clear: () => Promise<void>
  test: () => Promise<void>
} {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [languageDraft, setLanguageDraft] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([])
  const [testResult, setTestResult] = useState<CustomSttEndpointTestState | null>(null)

  // Why: once a base URL is typed, ask the endpoint what it supports so the Model
  // field can suggest real names. A miss is harmless — the field stays free text.
  useEffect(() => {
    if (!dialogOpen) {
      return
    }
    const baseUrl = baseUrlDraft.trim()
    if (!baseUrl) {
      setModelSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setDiscovering(true)
      void window.api.speech
        .discoverCustomEndpointModels({ baseUrl, apiKey: apiKeyDraft })
        .then((result) => {
          if (!cancelled) {
            setModelSuggestions(result.ok ? result.models : [])
          }
        })
        .catch(() => {
          if (!cancelled) {
            setModelSuggestions([])
          }
        })
        .finally(() => {
          if (!cancelled) {
            setDiscovering(false)
          }
        })
    }, DISCOVERY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [dialogOpen, baseUrlDraft, apiKeyDraft])

  const resetDrafts = useCallback((): void => {
    setBaseUrlDraft('')
    setModelDraft('')
    setLanguageDraft('')
    setApiKeyDraft('')
    setTestResult(null)
  }, [])

  // Why: opening the dialog must not change any setting — the endpoint model is
  // only selected on Save. Drafts are seeded from the persisted store for display,
  // so Cancel/Esc leaves the profile exactly as it was.
  const openDialog = useCallback((): void => {
    void window.api.speech
      .getCustomEndpointStatus()
      .then((status) => {
        setBaseUrlDraft(status.baseUrl)
        setModelDraft(status.model)
        setLanguageDraft(status.language)
      })
      .catch(() => {})
    setApiKeyDraft('')
    setTestResult(null)
    setDialogOpen(true)
  }, [])

  const cancel = useCallback((): void => {
    resetDrafts()
    setDialogOpen(false)
  }, [resetDrafts])

  const save = useCallback(async (): Promise<void> => {
    setPending(true)
    try {
      const status = await window.api.speech.saveCustomEndpoint({
        baseUrl: baseUrlDraft,
        model: modelDraft,
        language: languageDraft,
        apiKey: apiKeyDraft
      })
      updateVoiceSettings({
        customSttBaseUrl: status.baseUrl,
        customSttModel: status.model,
        customSttLanguage: status.language,
        customSttApiKeyConfigured: status.apiKeyConfigured,
        sttModel: 'custom-openai-compatible'
      })
      await refreshModelStates()
      resetDrafts()
      setDialogOpen(false)
      toast.success(
        translate(
          'auto.components.settings.VoicePane.customEndpointSaved',
          'Custom transcription endpoint saved'
        )
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.customEndpointSaveFailed',
              'Failed to save custom endpoint'
            )
      )
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }, [
    baseUrlDraft,
    modelDraft,
    languageDraft,
    apiKeyDraft,
    updateVoiceSettings,
    refreshModelStates,
    resetDrafts,
    isMounted
  ])

  const clear = useCallback(async (): Promise<void> => {
    setPending(true)
    try {
      await window.api.speech.clearCustomEndpoint()
      updateVoiceSettings({
        customSttBaseUrl: '',
        customSttModel: '',
        customSttLanguage: '',
        customSttApiKeyConfigured: false,
        sttModel: selectedModel?.provider === 'custom' ? '' : voiceSettings.sttModel
      })
      await refreshModelStates()
      resetDrafts()
      setDialogOpen(false)
      toast.success(
        translate(
          'auto.components.settings.VoicePane.customEndpointCleared',
          'Custom transcription endpoint cleared'
        )
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.customEndpointClearFailed',
              'Failed to clear custom endpoint'
            )
      )
    } finally {
      if (isMounted()) {
        setPending(false)
      }
    }
  }, [
    selectedModel,
    voiceSettings.sttModel,
    updateVoiceSettings,
    refreshModelStates,
    resetDrafts,
    isMounted
  ])

  const test = useCallback(async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.speech.testCustomEndpoint({
        baseUrl: baseUrlDraft,
        model: modelDraft,
        language: languageDraft
      })
      if (isMounted()) {
        setTestResult(result)
      }
    } catch (err) {
      if (isMounted()) {
        setTestResult({
          ok: false,
          outcome: 'transport',
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      if (isMounted()) {
        setTesting(false)
      }
    }
  }, [baseUrlDraft, modelDraft, languageDraft, isMounted])

  return {
    dialogOpen,
    baseUrlDraft,
    modelDraft,
    languageDraft,
    apiKeyDraft,
    pending,
    testing,
    discovering,
    modelSuggestions,
    testResult,
    setDialogOpen,
    setBaseUrlDraft,
    setModelDraft,
    setLanguageDraft,
    setApiKeyDraft,
    openDialog,
    cancel,
    save,
    clear,
    test
  }
}
