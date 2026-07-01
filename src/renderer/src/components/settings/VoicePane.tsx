import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Separator } from '../ui/separator'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { OpenAiTranscriptionKeyDialog } from './OpenAiTranscriptionKeyDialog'
import { OpenAiTranscriptionSettingsRow } from './OpenAiTranscriptionSettingsRow'
import { SarvamTranscriptionKeyDialog } from './SarvamTranscriptionKeyDialog'
import { SarvamTranscriptionSettingsRow } from './SarvamTranscriptionSettingsRow'
import { useCloudApiKeyActions } from './useCloudApiKeyActions'
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { matchesSettingsSearch } from './settings-search'
import {
  getOpenaiTranscriptionSearchEntry,
  getSarvamTranscriptionSearchEntry
} from './voice-pane-search'
import { translate } from '@/i18n/i18n'

export { handleVoiceDictationToggle }

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  const voiceSettings = settings.voice ?? getDefaultVoiceSettings()
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery ?? '')
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])
  const [permissionPending, setPermissionPending] = useState(false)
  const [pendingCloudModelId, setPendingCloudModelId] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const handlePaneRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const updateVoiceSettings = useCallback(
    (updates: Partial<VoiceSettings>): void => {
      updateSettings({
        voice: {
          ...voiceSettings,
          ...updates
        }
      })
    },
    [updateSettings, voiceSettings]
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
        if (!cancelled && status.configured !== voiceSettings.openAiApiKeyConfigured) {
          updateVoiceSettings({ openAiApiKeyConfigured: status.configured })
          refreshModelStates()
        }
      })
      .catch(() => {})
    void window.api.speech
      .getSarvamApiKeyStatus()
      .then((status) => {
        if (!cancelled && status.configured !== voiceSettings.sarvamApiKeyConfigured) {
          updateVoiceSettings({ sarvamApiKeyConfigured: status.configured })
          refreshModelStates()
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    refreshModelStates,
    updateVoiceSettings,
    voiceSettings.openAiApiKeyConfigured,
    voiceSettings.sarvamApiKeyConfigured
  ])

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
          translate(
            'auto.components.settings.VoicePane.cd9fe37556',
            'Microphone permission granted'
          )
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
    })
  }

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const showOpenAiSettingsRow =
    voiceSettings.openAiApiKeyConfigured ||
    selectedModel?.provider === 'openai' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getOpenaiTranscriptionSearchEntry()))
  const showSarvamSettingsRow =
    voiceSettings.sarvamApiKeyConfigured ||
    selectedModel?.provider === 'sarvam' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getSarvamTranscriptionSearchEntry()))

  const cloudKeyDeps = {
    updateVoiceSettings,
    refreshModelStates,
    mountedRef,
    currentSttModel: voiceSettings.sttModel,
    selectedProvider: selectedModel?.provider,
    pendingCloudModelId,
    setPendingCloudModelId
  }

  const openAiKey = useCloudApiKeyActions(
    {
      provider: 'openai',
      configuredField: 'openAiApiKeyConfigured',
      saveKey: (apiKey) => window.api.speech.saveOpenAiApiKey(apiKey),
      clearKey: () => window.api.speech.clearOpenAiApiKey(),
      messages: {
        saved: translate('auto.components.settings.VoicePane.506df81ba6', 'OpenAI API key saved'),
        saveFailed: translate(
          'auto.components.settings.VoicePane.8572bbb537',
          'Failed to save OpenAI API key'
        ),
        cleared: translate(
          'auto.components.settings.VoicePane.37aba8bb63',
          'OpenAI API key cleared'
        ),
        clearFailed: translate(
          'auto.components.settings.VoicePane.62d2a84d31',
          'Failed to clear OpenAI API key'
        )
      }
    },
    cloudKeyDeps
  )

  const sarvamKey = useCloudApiKeyActions(
    {
      provider: 'sarvam',
      configuredField: 'sarvamApiKeyConfigured',
      saveKey: (apiKey) => window.api.speech.saveSarvamApiKey(apiKey),
      clearKey: () => window.api.speech.clearSarvamApiKey(),
      messages: {
        saved: translate(
          'auto.components.settings.VoicePane.sarvamKeySaved',
          'Sarvam API key saved'
        ),
        saveFailed: translate(
          'auto.components.settings.VoicePane.sarvamKeySaveFailed',
          'Failed to save Sarvam API key'
        ),
        cleared: translate(
          'auto.components.settings.VoicePane.sarvamKeyCleared',
          'Sarvam API key cleared'
        ),
        clearFailed: translate(
          'auto.components.settings.VoicePane.sarvamKeyClearFailed',
          'Failed to clear Sarvam API key'
        )
      }
    },
    cloudKeyDeps
  )

  // Route a cloud model's key prompt to the dialog for its provider.
  const openCloudKeyDialog = (manifest: SpeechModelManifest): void => {
    if (manifest.provider === 'sarvam') {
      sarvamKey.openDialog(manifest.id)
    } else {
      openAiKey.openDialog(manifest.id)
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
        onOpenCloudKeyDialog={openCloudKeyDialog}
        onRefreshModelStates={refreshModelStates}
      />

      {showOpenAiSettingsRow && (
        <>
          <Separator />
          <OpenAiTranscriptionSettingsRow
            configured={voiceSettings.openAiApiKeyConfigured}
            disabled={openAiKey.pending}
            onConfigure={() => openAiKey.openDialog()}
            onClear={() => void openAiKey.clear()}
          />
        </>
      )}

      {showSarvamSettingsRow && (
        <>
          <Separator />
          <SarvamTranscriptionSettingsRow
            configured={voiceSettings.sarvamApiKeyConfigured}
            disabled={sarvamKey.pending}
            onConfigure={() => sarvamKey.openDialog()}
            onClear={() => void sarvamKey.clear()}
          />
        </>
      )}

      <OpenAiTranscriptionKeyDialog
        open={openAiKey.dialogOpen}
        configured={voiceSettings.openAiApiKeyConfigured}
        apiKeyDraft={openAiKey.apiKeyDraft}
        pending={openAiKey.pending}
        onOpenChange={openAiKey.setDialogOpen}
        onApiKeyDraftChange={openAiKey.setApiKeyDraft}
        onSave={() => void openAiKey.save()}
        onClear={() => void openAiKey.clear()}
      />

      <SarvamTranscriptionKeyDialog
        open={sarvamKey.dialogOpen}
        configured={voiceSettings.sarvamApiKeyConfigured}
        apiKeyDraft={sarvamKey.apiKeyDraft}
        pending={sarvamKey.pending}
        onOpenChange={sarvamKey.setDialogOpen}
        onApiKeyDraftChange={sarvamKey.setApiKeyDraft}
        onSave={() => void sarvamKey.save()}
        onClear={() => void sarvamKey.clear()}
      />
    </div>
  )
}
