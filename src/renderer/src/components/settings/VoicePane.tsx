import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Separator } from '../ui/separator'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { CloudTranscriptionKeyDialog } from './CloudTranscriptionKeyDialog'
import { CloudTranscriptionSettingsRow } from './CloudTranscriptionSettingsRow'
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { matchesSettingsSearch } from './settings-search'
import {
  getOpenaiTranscriptionSearchEntry,
  getSonioxTranscriptionSearchEntry
} from './voice-pane-search'
import { translate } from '@/i18n/i18n'
import { useSpeechApiKeySettings } from './use-speech-api-key-settings'

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
      .getSonioxApiKeyStatus()
      .then((status) => {
        if (!cancelled && status.configured !== voiceSettings.sonioxApiKeyConfigured) {
          updateVoiceSettings({ sonioxApiKeyConfigured: status.configured })
          refreshModelStates()
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
    return () => {
      cancelled = true
    }
  }, [
    refreshModelStates,
    updateVoiceSettings,
    voiceSettings.openAiApiKeyConfigured,
    voiceSettings.sonioxApiKeyConfigured
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
  const openAiKey = useSpeechApiKeySettings({
    provider: 'openai',
    currentModelId: voiceSettings.sttModel,
    selectedProvider: selectedModel?.provider,
    updateVoiceSettings,
    refreshModelStates,
    isMounted: () => mountedRef.current
  })
  const sonioxKey = useSpeechApiKeySettings({
    provider: 'soniox',
    currentModelId: voiceSettings.sttModel,
    selectedProvider: selectedModel?.provider,
    updateVoiceSettings,
    refreshModelStates,
    isMounted: () => mountedRef.current
  })
  const showOpenAiSettingsRow =
    voiceSettings.openAiApiKeyConfigured ||
    selectedModel?.provider === 'openai' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getOpenaiTranscriptionSearchEntry()))
  const showSonioxSettingsRow =
    voiceSettings.sonioxApiKeyConfigured ||
    selectedModel?.provider === 'soniox' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getSonioxTranscriptionSearchEntry()))

  const openCloudDialog = (provider: 'openai' | 'soniox', modelId: string): void => {
    const keySettings = provider === 'openai' ? openAiKey : sonioxKey
    keySettings.openDialog(modelId)
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
        onOpenCloudDialog={openCloudDialog}
        onRefreshModelStates={refreshModelStates}
      />

      {showOpenAiSettingsRow && (
        <>
          <Separator />
          <CloudTranscriptionSettingsRow
            provider="openai"
            configured={voiceSettings.openAiApiKeyConfigured}
            disabled={openAiKey.pending}
            onConfigure={() => openAiKey.openDialog()}
            onClear={() => void openAiKey.clear()}
          />
        </>
      )}

      {showSonioxSettingsRow && (
        <>
          <Separator />
          <CloudTranscriptionSettingsRow
            provider="soniox"
            configured={voiceSettings.sonioxApiKeyConfigured}
            disabled={sonioxKey.pending}
            onConfigure={() => sonioxKey.openDialog()}
            onClear={() => void sonioxKey.clear()}
          />
        </>
      )}

      <CloudTranscriptionKeyDialog
        provider="openai"
        open={openAiKey.open}
        configured={voiceSettings.openAiApiKeyConfigured}
        apiKeyDraft={openAiKey.draft}
        pending={openAiKey.pending}
        onOpenChange={openAiKey.setOpen}
        onApiKeyDraftChange={openAiKey.setDraft}
        onSave={() => void openAiKey.save()}
        onClear={() => void openAiKey.clear()}
      />
      <CloudTranscriptionKeyDialog
        provider="soniox"
        open={sonioxKey.open}
        configured={voiceSettings.sonioxApiKeyConfigured}
        apiKeyDraft={sonioxKey.draft}
        pending={sonioxKey.pending}
        onOpenChange={sonioxKey.setOpen}
        onApiKeyDraftChange={sonioxKey.setDraft}
        onSave={() => void sonioxKey.save()}
        onClear={() => void sonioxKey.clear()}
      />
    </div>
  )
}
