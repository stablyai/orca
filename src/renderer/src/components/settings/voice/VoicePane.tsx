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
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { VoiceDictationLanguageSetting } from './VoiceDictationLanguageSetting'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'
import { VoiceModelUnloadSetting } from './VoiceModelUnloadSetting'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'
import { getOpenaiTranscriptionSearchEntry } from './voice-pane-search'
import { useTranslate } from '@/i18n/use-translate'
import { readIpcErrorMessage } from '@/lib/ipc-error'

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
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery ?? '')
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])
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

  const toggleVoiceDictation = async (): Promise<void> => {
    await handleVoiceDictationToggle({
      voiceEnabled: voiceSettings.enabled,
      markFeatureTipsSeen,
      updateVoiceSettings,
      requestMicrophonePermission: () =>
        window.api.developerPermissions.request({ id: 'microphone' }),
      setPermissionPending,
      isMounted: () => mountedRef.current,
      notifyPermissionGranted: () =>
        toast.success(
          t('auto.components.settings.VoicePane.cd9fe37556', 'Microphone permission granted')
        ),
      notifyPermissionOpenedSystemSettings: () =>
        toast.message(
          t(
            'auto.components.settings.VoicePane.1eac933202',
            'Opened macOS Privacy & Security. Enable dictation again after granting access.'
          )
        ),
      notifyPermissionRequired: () =>
        toast.message(
          t(
            'auto.components.settings.VoicePane.f9a9cf6928',
            'Microphone permission is required before enabling voice dictation.'
          )
        ),
      notifyPermissionRequestFailed: () =>
        toast.error(
          t(
            'auto.components.settings.VoicePane.ad5d036ecc',
            'Could not request microphone permission. Voice dictation was not enabled.'
          )
        )
    })
  }

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const showOpenAiSettingsRow =
    voiceSettings.openAiApiKeyConfigured ||
    selectedModel?.provider === 'openai' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getOpenaiTranscriptionSearchEntry()))

  const compatibleModel = catalog.find((m) => m.provider === 'openai-compatible')
  const compatibleConfigured =
    compatibleModel !== undefined &&
    modelStates.some((s) => s.id === compatibleModel.id && s.status === 'ready')
  const showCompatibleSettingsRow =
    compatibleConfigured || selectedModel?.provider === 'openai-compatible'

  const openOpenAiDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setOpenAiApiKeyDraft('')
    setOpenAiDialogOpen(true)
  }

  const openCompatibleDialog = (modelId: string | null): void => {
    setPendingCloudModelId(modelId)
    setCompatibleDialogOpen(true)
  }

  const openCloudSetup = (manifest: SpeechModelManifest): void => {
    if (manifest.provider === 'openai-compatible') {
      openCompatibleDialog(manifest.id)
    } else {
      openOpenAiDialog(manifest.id)
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

  return (
    <div ref={handlePaneRef} className="space-y-1">
      <VoiceDictationSettingsSection
        voiceSettings={voiceSettings}
        permissionPending={permissionPending}
        onToggleVoiceDictation={() => void toggleVoiceDictation()}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      <VoiceSpeechModelSection
        voiceSettings={voiceSettings}
        catalog={catalog}
        modelStates={modelStates}
        onUpdateVoiceSettings={updateVoiceSettings}
        onOpenCloudSetup={openCloudSetup}
        onRefreshModelStates={refreshModelStates}
      />

      <Separator />

      <VoiceDictationLanguageSetting
        voiceSettings={voiceSettings}
        selectedModel={selectedModel}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      <Separator />

      <SettingsSwitchRow
        label={t('components.settings.voice.fillerWords.title', 'Remove Filler Words')}
        description={t(
          'components.settings.voice.fillerWords.description',
          'Drops sounds like “um” and “uh” from dictated text, in the dictation language.'
        )}
        checked={voiceSettings.removeFillerWords}
        onChange={() =>
          updateVoiceSettings({ removeFillerWords: !voiceSettings.removeFillerWords })
        }
      />

      <Separator />

      <VoiceModelUnloadSetting
        voiceSettings={voiceSettings}
        selectedModel={selectedModel}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      {showOpenAiSettingsRow && (
        <>
          <Separator />
          <UnsealedCredentialNotice
            protection={openAiKeyProtection}
            credentialName={t(
              'auto.components.settings.VoicePane.openAiKeyName',
              'Your OpenAI transcription key'
            )}
          />
          <OpenAiTranscriptionSettingsRow
            configured={voiceSettings.openAiApiKeyConfigured}
            disabled={openAiKeyPending}
            onConfigure={() => openOpenAiDialog(null)}
            onClear={() => void clearOpenAiApiKey()}
          />
        </>
      )}

      {showCompatibleSettingsRow && (
        <>
          <Separator />
          <OpenAiTranscriptionSettingsRow
            variant="compatible"
            configured={compatibleConfigured}
            disabled={false}
            onConfigure={() => openCompatibleDialog(null)}
            onClear={() => void removeCompatibleProvider()}
          />
        </>
      )}

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
