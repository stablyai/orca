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
  const [openAiDialogOpen, setOpenAiDialogOpen] = useState(false)
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('')
  const [openAiKeyPending, setOpenAiKeyPending] = useState(false)
  const [sarvamDialogOpen, setSarvamDialogOpen] = useState(false)
  const [sarvamApiKeyDraft, setSarvamApiKeyDraft] = useState('')
  const [sarvamKeyPending, setSarvamKeyPending] = useState(false)
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

  const openOpenAiDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setOpenAiApiKeyDraft('')
    setOpenAiDialogOpen(true)
  }

  const openSarvamDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setSarvamApiKeyDraft('')
    setSarvamDialogOpen(true)
  }

  // Route a cloud model's key prompt to the dialog for its provider.
  const openCloudKeyDialog = (manifest: SpeechModelManifest): void => {
    if (manifest.provider === 'sarvam') {
      openSarvamDialog(manifest.id)
    } else {
      openOpenAiDialog(manifest.id)
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
      toast.success(
        translate('auto.components.settings.VoicePane.506df81ba6', 'OpenAI API key saved')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.8572bbb537',
              'Failed to save OpenAI API key'
            )
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
      toast.success(
        translate('auto.components.settings.VoicePane.37aba8bb63', 'OpenAI API key cleared')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.62d2a84d31',
              'Failed to clear OpenAI API key'
            )
      )
    } finally {
      if (mountedRef.current) {
        setOpenAiKeyPending(false)
      }
    }
  }

  const saveSarvamApiKey = async (): Promise<void> => {
    setSarvamKeyPending(true)
    try {
      await window.api.speech.saveSarvamApiKey(sarvamApiKeyDraft)
      updateVoiceSettings({
        sarvamApiKeyConfigured: true,
        sttModel: pendingCloudModelId ?? voiceSettings.sttModel
      })
      await refreshModelStates()
      setSarvamDialogOpen(false)
      setSarvamApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(
        translate('auto.components.settings.VoicePane.sarvamKeySaved', 'Sarvam API key saved')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.sarvamKeySaveFailed',
              'Failed to save Sarvam API key'
            )
      )
    } finally {
      if (mountedRef.current) {
        setSarvamKeyPending(false)
      }
    }
  }

  const clearSarvamApiKey = async (): Promise<void> => {
    setSarvamKeyPending(true)
    try {
      await window.api.speech.clearSarvamApiKey()
      updateVoiceSettings({
        sarvamApiKeyConfigured: false,
        sttModel: selectedModel?.provider === 'sarvam' ? '' : voiceSettings.sttModel
      })
      await refreshModelStates()
      setSarvamDialogOpen(false)
      setSarvamApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(
        translate('auto.components.settings.VoicePane.sarvamKeyCleared', 'Sarvam API key cleared')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.sarvamKeyClearFailed',
              'Failed to clear Sarvam API key'
            )
      )
    } finally {
      if (mountedRef.current) {
        setSarvamKeyPending(false)
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
        onOpenCloudKeyDialog={openCloudKeyDialog}
        onRefreshModelStates={refreshModelStates}
      />

      {showOpenAiSettingsRow && (
        <>
          <Separator />
          <OpenAiTranscriptionSettingsRow
            configured={voiceSettings.openAiApiKeyConfigured}
            disabled={openAiKeyPending}
            onConfigure={() => openOpenAiDialog(null)}
            onClear={() => void clearOpenAiApiKey()}
          />
        </>
      )}

      {showSarvamSettingsRow && (
        <>
          <Separator />
          <SarvamTranscriptionSettingsRow
            configured={voiceSettings.sarvamApiKeyConfigured}
            disabled={sarvamKeyPending}
            onConfigure={() => openSarvamDialog(null)}
            onClear={() => void clearSarvamApiKey()}
          />
        </>
      )}

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

      <SarvamTranscriptionKeyDialog
        open={sarvamDialogOpen}
        configured={voiceSettings.sarvamApiKeyConfigured}
        apiKeyDraft={sarvamApiKeyDraft}
        pending={sarvamKeyPending}
        onOpenChange={setSarvamDialogOpen}
        onApiKeyDraftChange={setSarvamApiKeyDraft}
        onSave={() => void saveSarvamApiKey()}
        onClear={() => void clearSarvamApiKey()}
      />
    </div>
  )
}
