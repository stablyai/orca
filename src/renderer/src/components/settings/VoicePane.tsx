import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Separator } from '../ui/separator'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ElevenLabsTranscriptionKeyDialog } from './ElevenLabsTranscriptionKeyDialog'
import { ElevenLabsTranscriptionSettingsRow } from './ElevenLabsTranscriptionSettingsRow'
import { OpenAiTranscriptionKeyDialog } from './OpenAiTranscriptionKeyDialog'
import { OpenAiTranscriptionSettingsRow } from './OpenAiTranscriptionSettingsRow'
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { matchesSettingsSearch } from './settings-search'
import {
  getElevenLabsTranscriptionSearchEntry,
  getOpenaiTranscriptionSearchEntry
} from './voice-pane-search'
import { translate } from '@/i18n/i18n'

export { handleVoiceDictationToggle }

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  // Why: a stable fallback prevents the fetch effect from repeating on every parent render.
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
  const [elevenLabsDialogOpen, setElevenLabsDialogOpen] = useState(false)
  const [elevenLabsApiKeyDraft, setElevenLabsApiKeyDraft] = useState('')
  const [elevenLabsKeyPending, setElevenLabsKeyPending] = useState(false)
  const [pendingCloudModelId, setPendingCloudModelId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Why: every write here is a read-modify-write of the whole voice object, and the
  // writers are async (key status probe, save/clear key). Merging onto the render-time
  // snapshot would resurrect settings that changed while the IPC was in flight — e.g.
  // reverting `enabled` to false and leaving the microphone picker permanently disabled.
  // Written in an effect, not during render: the async writers all run post-commit.
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
    // Why: both probes write the same `voice` object, so resolve them together and hand the
    // settings store one merged update — two racing writers would drop one provider's flag.
    void Promise.all([
      window.api.speech.getOpenAiApiKeyStatus().catch(() => null),
      window.api.speech.getElevenLabsApiKeyStatus().catch(() => null)
    ]).then(([openAiStatus, elevenLabsStatus]) => {
      if (cancelled) {
        return
      }
      const updates: Partial<VoiceSettings> = {}
      if (openAiStatus && openAiStatus.configured !== voiceSettings.openAiApiKeyConfigured) {
        updates.openAiApiKeyConfigured = openAiStatus.configured
      }
      if (
        elevenLabsStatus &&
        elevenLabsStatus.configured !== voiceSettings.elevenLabsApiKeyConfigured
      ) {
        updates.elevenLabsApiKeyConfigured = elevenLabsStatus.configured
      }
      if (Object.keys(updates).length > 0) {
        updateVoiceSettings(updates)
        refreshModelStates()
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    refreshModelStates,
    updateVoiceSettings,
    voiceSettings.openAiApiKeyConfigured,
    voiceSettings.elevenLabsApiKeyConfigured
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
  const showElevenLabsSettingsRow =
    voiceSettings.elevenLabsApiKeyConfigured ||
    selectedModel?.provider === 'elevenlabs' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, getElevenLabsTranscriptionSearchEntry()))

  const openOpenAiDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setOpenAiApiKeyDraft('')
    setOpenAiDialogOpen(true)
  }

  const openElevenLabsDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setElevenLabsApiKeyDraft('')
    setElevenLabsDialogOpen(true)
  }

  // Why: the model list only knows a model is cloud; the pane routes it to the provider whose
  // key makes it selectable, keeping provider knowledge out of the dropdown.
  const openCloudDialog = (modelId: string): void => {
    if (catalog.find((m) => m.id === modelId)?.provider === 'elevenlabs') {
      openElevenLabsDialog(modelId)
      return
    }
    openOpenAiDialog(modelId)
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

  const saveElevenLabsApiKey = async (): Promise<void> => {
    setElevenLabsKeyPending(true)
    try {
      await window.api.speech.saveElevenLabsApiKey(elevenLabsApiKeyDraft)
      updateVoiceSettings({
        elevenLabsApiKeyConfigured: true,
        sttModel: pendingCloudModelId ?? voiceSettings.sttModel
      })
      await refreshModelStates()
      setElevenLabsDialogOpen(false)
      setElevenLabsApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(
        translate('auto.components.settings.VoicePane.2ccb18cca4', 'ElevenLabs API key saved')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.21b58e3e55',
              'Failed to save ElevenLabs API key'
            )
      )
    } finally {
      if (mountedRef.current) {
        setElevenLabsKeyPending(false)
      }
    }
  }

  const clearElevenLabsApiKey = async (): Promise<void> => {
    setElevenLabsKeyPending(true)
    try {
      await window.api.speech.clearElevenLabsApiKey()
      updateVoiceSettings({
        elevenLabsApiKeyConfigured: false,
        sttModel: selectedModel?.provider === 'elevenlabs' ? '' : voiceSettings.sttModel
      })
      await refreshModelStates()
      setElevenLabsDialogOpen(false)
      setElevenLabsApiKeyDraft('')
      setPendingCloudModelId(null)
      toast.success(
        translate('auto.components.settings.VoicePane.e180cc22b6', 'ElevenLabs API key cleared')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.VoicePane.95a5aa12a0',
              'Failed to clear ElevenLabs API key'
            )
      )
    } finally {
      if (mountedRef.current) {
        setElevenLabsKeyPending(false)
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
        onOpenCloudDialog={openCloudDialog}
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

      {showElevenLabsSettingsRow && (
        <>
          <Separator />
          <ElevenLabsTranscriptionSettingsRow
            configured={voiceSettings.elevenLabsApiKeyConfigured}
            disabled={elevenLabsKeyPending}
            onConfigure={() => openElevenLabsDialog(null)}
            onClear={() => void clearElevenLabsApiKey()}
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

      <ElevenLabsTranscriptionKeyDialog
        open={elevenLabsDialogOpen}
        configured={voiceSettings.elevenLabsApiKeyConfigured}
        apiKeyDraft={elevenLabsApiKeyDraft}
        pending={elevenLabsKeyPending}
        onOpenChange={setElevenLabsDialogOpen}
        onApiKeyDraftChange={setElevenLabsApiKeyDraft}
        onSave={() => void saveElevenLabsApiKey()}
        onClear={() => void clearElevenLabsApiKey()}
      />
    </div>
  )
}
