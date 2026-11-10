import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import type { SecretAtRestProtection } from '../../../../../shared/secret-at-rest-protection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import { Separator } from '../../ui/separator'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { OpenAiTranscriptionKeyDialog } from './OpenAiTranscriptionKeyDialog'
import { OpenAiCompatibleProviderDialog } from './OpenAiCompatibleProviderDialog'
import { OpenAiTranscriptionSettingsRow } from './OpenAiTranscriptionSettingsRow'
import {
  handleVoiceDictationToggle,
  voiceDictationPermissionToasts
} from './voice-dictation-toggle'
import { VoiceDictationLanguageSetting } from './VoiceDictationLanguageSetting'
import { VoiceVocabularySetting } from './VoiceVocabularySetting'
import { VOICE_MICROPHONE_ROW_ID, VoiceInputSettings } from './VoiceInputSettings'
import { VoiceSetupCard } from './VoiceSetupCard'
import { cancelSpeechModelDownload, startSpeechModelDownload } from './speech-model-download'
import { VoiceModelUnloadSetting } from './VoiceModelUnloadSetting'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { SettingsSubsectionHeader, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { VoiceSpeechGpuSetting } from './VoiceSpeechGpuSetting'
import { useTranslate } from '@/i18n/use-translate'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import {
  speechModelQuality,
  speechModelRatingLanguage
} from '../../../../../shared/speech-model-quality'
import { suggestSpeechModel } from '../../../../../shared/speech-model-suggestion'

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  const t = useTranslate()
  // Keep fallback identity stable so parent renders cannot repeat fetch effects.
  const [defaultVoiceSettings] = useState(getDefaultVoiceSettings)
  const voiceSettings = settings.voice ?? defaultVoiceSettings
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const systemLanguageTag = useLanguageReadiness((s) => s.detection?.detectedTag)
  // null until main answers, so the card and list never show a state the catalog would contradict.
  const [loadedCatalog, setCatalog] = useState<SpeechModelManifest[] | null>(null)
  const catalog = loadedCatalog ?? []
  const [permissionPending, setPermissionPending] = useState(false)
  const [openAiDialogOpen, setOpenAiDialogOpen] = useState(false)
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('')
  const [openAiKeyPending, setOpenAiKeyPending] = useState(false)
  const [openAiKeyProtection, setOpenAiKeyProtection] = useState<SecretAtRestProtection | null>(
    null
  )
  const [pendingCloudModelId, setPendingCloudModelId] = useState<string | null>(null)
  const [compatibleDialogOpen, setCompatibleDialogOpen] = useState(false)
  const mountedRef = useRef(true)
  // Merge async whole-object writes into committed current settings; render snapshots could undo toggles changed during IPC and disable the microphone picker.
  const voiceSettingsRef = useRef(voiceSettings)
  useEffect(() => {
    voiceSettingsRef.current = voiceSettings
  }, [voiceSettings])

  const handlePaneRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const updateVoiceSettings = useCallback(
    (updates: Partial<VoiceSettings>): void => {
      updateSettings({
        voice: {
          ...voiceSettingsRef.current,
          ...updates
        }
      })
    },
    [updateSettings]
  )

  useEffect(() => {
    let cancelled = false
    refreshModelStates()
    void window.api.speech
      .getCatalog()
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog)
        }
      })
      .catch(() => {})
    void window.api.speech
      .getOpenAiApiKeyStatus()
      .then((status) => {
        if (cancelled) {
          return
        }
        setOpenAiKeyProtection(status.protection)
        if (status.configured !== voiceSettings.openAiApiKeyConfigured) {
          updateVoiceSettings({ openAiApiKeyConfigured: status.configured })
          refreshModelStates()
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshModelStates, updateVoiceSettings, voiceSettings.openAiApiKeyConfigured])

  useEffect(() => {
    const cleanup = window.api.speech.onDownloadProgress(() => {
      refreshModelStates()
    })
    return cleanup
  }, [refreshModelStates])

  const toggleVoiceDictation = async (alongside?: Partial<VoiceSettings>): Promise<void> => {
    await handleVoiceDictationToggle({
      voiceEnabled: voiceSettings.enabled,
      markFeatureTipsSeen,
      updateVoiceSettings: (updates) => updateVoiceSettings({ ...alongside, ...updates }),
      requestMicrophonePermission: () =>
        window.api.developerPermissions.request({ id: 'microphone' }),
      setPermissionPending,
      isMounted: () => mountedRef.current,
      ...voiceDictationPermissionToasts
    })
  }

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)

  const compatibleModel = catalog.find((m) => m.provider === 'openai-compatible')
  const compatibleConfigured =
    compatibleModel !== undefined &&
    modelStates.some((s) => s.id === compatibleModel.id && s.status === 'ready')

  const openOpenAiDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setOpenAiApiKeyDraft('')
    setOpenAiDialogOpen(true)
  }

  const openCompatibleDialog = (modelId: string | null): void => {
    setPendingCloudModelId(modelId)
    setCompatibleDialogOpen(true)
  }

  const openCloudSetup = (modelId: string): void => {
    if (catalog.find((m) => m.id === modelId)?.provider === 'openai-compatible') {
      openCompatibleDialog(modelId)
    } else {
      openOpenAiDialog(modelId)
    }
  }

  const handleCompatibleSaved = (): void => {
    if (pendingCloudModelId) {
      updateVoiceSettings({ sttModel: pendingCloudModelId })
    }
    setPendingCloudModelId(null)
    refreshModelStates()
  }

  const removeCompatibleProvider = async (): Promise<void> => {
    try {
      await window.api.speech.clearOpenAiCompatibleProvider()
      if (selectedModel?.provider === 'openai-compatible') {
        updateVoiceSettings({ sttModel: '' })
      }
      refreshModelStates()
    } catch (err) {
      toast.error(
        readIpcErrorMessage(err) ??
          t(
            'components.settings.voice.openAiCompatible.updateFailed',
            'Could not update the provider'
          )
      )
    }
  }

  const saveOpenAiApiKey = async (): Promise<void> => {
    setOpenAiKeyPending(true)
    try {
      await window.api.speech.saveOpenAiApiKey(openAiApiKeyDraft)
      updateVoiceSettings({
        openAiApiKeyConfigured: true,
        sttModel: pendingCloudModelId ?? voiceSettings.sttModel
      })
      await refreshModelStates()
      setOpenAiDialogOpen(false)
      setOpenAiApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(t('auto.components.settings.VoicePane.506df81ba6', 'OpenAI API key saved'))
    } catch (err) {
      toast.error(
        readIpcErrorMessage(err) ??
          t('auto.components.settings.VoicePane.8572bbb537', 'Failed to save OpenAI API key')
      )
    } finally {
      if (mountedRef.current) {
        setOpenAiKeyPending(false)
      }
    }
  }

  const clearOpenAiApiKey = async (): Promise<void> => {
    setOpenAiKeyPending(true)
    try {
      await window.api.speech.clearOpenAiApiKey()
      updateVoiceSettings({
        openAiApiKeyConfigured: false,
        sttModel: selectedModel?.provider === 'openai' ? '' : voiceSettings.sttModel
      })
      await refreshModelStates()
      setOpenAiDialogOpen(false)
      setOpenAiApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(t('auto.components.settings.VoicePane.37aba8bb63', 'OpenAI API key cleared'))
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('auto.components.settings.VoicePane.62d2a84d31', 'Failed to clear OpenAI API key')
      )
    } finally {
      if (mountedRef.current) {
        setOpenAiKeyPending(false)
      }
    }
  }

  const selectedState = modelStates.find((s) => s.id === voiceSettings.sttModel)
  const ratingLanguage =
    speechModelRatingLanguage(voiceSettings.dictationLanguage, systemLanguageTag ?? undefined) ??
    'en'
  const platform = window.api.platform?.get()
  const suggestedModel = suggestSpeechModel(catalog, ratingLanguage, {
    selectedModelId: voiceSettings.sttModel,
    // Metal runs the large models fast; other machines get the small, quick ones.
    favorAccuracy:
      platform?.platform === 'darwin' &&
      platform.arch === 'arm64' &&
      voiceSettings.speechGpu !== 'off'
  })

  const setUpDictation = (): void => {
    if (!suggestedModel) {
      return
    }
    // Select and download first, so the download runs while the OS asks for the microphone.
    const selection = { sttModel: suggestedModel.id }
    updateVoiceSettings(selection)
    startSpeechModelDownload(suggestedModel.id, refreshModelStates)
    if (!voiceSettings.enabled) {
      // The enable write repeats the selection: it can land before the first write's reply refreshes the ref.
      void toggleVoiceDictation(selection)
    }
  }

  return (
    <div ref={handlePaneRef} className="space-y-6">
      {loadedCatalog ? (
        <>
          <VoiceSetupCard
            voiceSettings={voiceSettings}
            selectedModel={selectedModel}
            selectedState={selectedState}
            permissionPending={permissionPending}
            onToggleVoiceDictation={() => void toggleVoiceDictation()}
            onDownloadModel={(modelId) => startSpeechModelDownload(modelId, refreshModelStates)}
            onCancelDownload={(modelId) => cancelSpeechModelDownload(modelId, refreshModelStates)}
            onShowMicrophone={() =>
              document
                .getElementById(VOICE_MICROPHONE_ROW_ID)
                ?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: 'center' })
            }
            suggestion={
              suggestedModel && {
                model: suggestedModel,
                quality: speechModelQuality(suggestedModel, ratingLanguage)
              }
            }
            onSetUp={setUpDictation}
          />

          <VoiceSpeechModelSection
            voiceSettings={voiceSettings}
            catalog={catalog}
            modelStates={modelStates}
            ratingLanguage={ratingLanguage}
            onUpdateVoiceSettings={updateVoiceSettings}
            onOpenCloudSetup={openCloudSetup}
            onRefreshModelStates={refreshModelStates}
            cloudSettings={
              <>
                {voiceSettings.openAiApiKeyConfigured ? (
                  <>
                    <UnsealedCredentialNotice
                      protection={openAiKeyProtection}
                      credentialName={t(
                        'auto.components.settings.VoicePane.openAiKeyName',
                        'Your OpenAI transcription key'
                      )}
                    />
                    <OpenAiTranscriptionSettingsRow
                      configured
                      disabled={openAiKeyPending}
                      onConfigure={() => openOpenAiDialog(null)}
                      onClear={() => void clearOpenAiApiKey()}
                    />
                  </>
                ) : null}
                {compatibleConfigured ? (
                  <OpenAiTranscriptionSettingsRow
                    variant="compatible"
                    configured
                    disabled={false}
                    onConfigure={() => openCompatibleDialog(null)}
                    onClear={() => void removeCompatibleProvider()}
                  />
                ) : null}
              </>
            }
          />
        </>
      ) : null}

      <Separator />

      <div className="space-y-1">
        <SettingsSubsectionHeader
          title={t('components.settings.voice.language.title', 'Language')}
        />
        <VoiceDictationLanguageSetting
          voiceSettings={voiceSettings}
          selectedModel={selectedModel}
          onUpdateVoiceSettings={updateVoiceSettings}
        />
      </div>

      <Separator />

      <VoiceVocabularySetting
        voiceSettings={voiceSettings}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      <Separator />

      <div className="space-y-1">
        <SettingsSubsectionHeader title={t('components.settings.voice.cleanup.title', 'Cleanup')} />
        <SettingsSwitchRow
          label={t('components.settings.voice.fillerWords.0134406785', 'Remove filler words')}
          description={t(
            'components.settings.voice.fillerWords.description',
            'Drops sounds like “um” and “uh” from dictated text, in the dictation language.'
          )}
          checked={voiceSettings.removeFillerWords}
          onChange={() =>
            updateVoiceSettings({ removeFillerWords: !voiceSettings.removeFillerWords })
          }
        />
      </div>

      <Separator />

      <VoiceInputSettings
        voiceSettings={voiceSettings}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      <Separator />

      <div className="space-y-1">
        <SettingsSubsectionHeader
          title={t('components.settings.voice.advanced.title', 'Advanced')}
        />
        <div className="divide-y divide-border">
          <VoiceSpeechGpuSetting
            voiceSettings={voiceSettings}
            onUpdateVoiceSettings={updateVoiceSettings}
          />
          <VoiceModelUnloadSetting
            voiceSettings={voiceSettings}
            selectedModel={selectedModel}
            onUpdateVoiceSettings={updateVoiceSettings}
          />
        </div>
      </div>

      <OpenAiCompatibleProviderDialog
        open={compatibleDialogOpen}
        onOpenChange={setCompatibleDialogOpen}
        onSaved={handleCompatibleSaved}
      />

      <OpenAiTranscriptionKeyDialog
        open={openAiDialogOpen}
        configured={voiceSettings.openAiApiKeyConfigured}
        apiKeyDraft={openAiApiKeyDraft}
        pending={openAiKeyPending}
        onOpenChange={setOpenAiDialogOpen}
        onApiKeyDraftChange={setOpenAiApiKeyDraft}
        onSave={() => void saveOpenAiApiKey()}
        onClear={() => void clearOpenAiApiKey()}
      />
    </div>
  )
}
