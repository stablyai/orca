import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import {
  getCloudSpeechProvider,
  type CloudSpeechProviderId
} from '../../../../shared/cloud-speech-providers'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Separator } from '../ui/separator'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { CloudSpeechProviderKeyDialog } from './CloudSpeechProviderKeyDialog'
import { CloudSpeechProvidersSection } from './CloudSpeechProvidersSection'
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { useCloudSpeechKeys } from './voice-cloud-speech-keys'
import { describeSpeechIpcError } from './voice-speech-ipc-error'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { VoiceTranscriptionLanguageSetting } from './VoiceTranscriptionLanguageSetting'
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
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])
  // Why: async key clears must resolve the selected model against the newest catalog, not the click-time one.
  const catalogRef = useRef(catalog)
  useEffect(() => {
    catalogRef.current = catalog
  }, [catalog])
  const [permissionPending, setPermissionPending] = useState(false)
  const cloudKeys = useCloudSpeechKeys()
  const refreshCloudKeys = cloudKeys.refresh
  const [keyDialogSession, setKeyDialogSession] = useState(0)
  // Why: a save that outlives its dialog must not close or pick a model for a newer dialog.
  const keyDialogSessionRef = useRef(0)
  // Why: the last provider stays set after close so the closing animation keeps its title.
  const [keyDialog, setKeyDialog] = useState<{
    providerId: CloudSpeechProviderId
    pendingModelId: string | null
  } | null>(null)
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
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
    void refreshCloudKeys().then((statuses) => {
      const openAiConfigured = statuses?.find(
        (status) => status.providerId === 'openai'
      )?.configured
      // Why: openAiApiKeyConfigured is a legacy settings mirror; resync it once from the key files.
      if (
        cancelled ||
        openAiConfigured === undefined ||
        openAiConfigured === voiceSettingsRef.current.openAiApiKeyConfigured
      ) {
        return
      }
      updateVoiceSettings({ openAiApiKeyConfigured: openAiConfigured })
      refreshModelStates()
    })
    return () => {
      cancelled = true
    }
  }, [refreshCloudKeys, refreshModelStates, updateVoiceSettings])

  // Why: the phone saves/clears keys in main and re-publishes `voice`; re-read key + model state then.
  const seenVoiceSettingsRef = useRef(voiceSettings)
  useEffect(() => {
    if (seenVoiceSettingsRef.current === voiceSettings) {
      return
    }
    seenVoiceSettingsRef.current = voiceSettings
    void refreshCloudKeys()
    refreshModelStates()
  }, [voiceSettings, refreshCloudKeys, refreshModelStates])

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

  const openKeyDialog = (
    providerId: CloudSpeechProviderId,
    pendingModelId: string | null
  ): void => {
    keyDialogSessionRef.current += 1
    setKeyDialogSession(keyDialogSessionRef.current)
    setKeyDialog({ providerId, pendingModelId })
    setKeyDialogOpen(true)
  }

  const saveCloudKey = async (apiKey: string, verify: boolean): Promise<void> => {
    if (!keyDialog) {
      return
    }
    const { providerId, pendingModelId } = keyDialog
    const session = keyDialogSessionRef.current
    await cloudKeys.saveKey(providerId, apiKey, verify)
    const stillCurrent = keyDialogSessionRef.current === session
    updateVoiceSettings({
      ...(providerId === 'openai' ? { openAiApiKeyConfigured: true } : {}),
      ...(pendingModelId && stillCurrent ? { sttModel: pendingModelId } : {})
    })
    // Why: the key is already saved; a failed state refresh must not read as a save error.
    await Promise.resolve(refreshModelStates()).catch(() => {})
    if (mountedRef.current && keyDialogSessionRef.current === session) {
      setKeyDialogOpen(false)
    }
    toast.success(
      translate('auto.components.settings.VoicePane.cloudKeySaved', '{{provider}} API key saved', {
        provider: getCloudSpeechProvider(providerId).label
      })
    )
  }

  const loadLatestCatalog = async (): Promise<SpeechModelManifest[]> => {
    if (catalogRef.current.length > 0) {
      return catalogRef.current
    }
    // Why: a clear before the first catalog fetch lands would otherwise keep the provider's model selected.
    const fetched = await window.api.speech.getCatalog().catch(() => [])
    if (fetched.length > 0 && mountedRef.current) {
      setCatalog(fetched)
    }
    return fetched
  }

  const clearCloudKey = async (providerId: CloudSpeechProviderId): Promise<void> => {
    const providerLabel = getCloudSpeechProvider(providerId).label
    try {
      await cloudKeys.clearKey(providerId)
      const latestCatalog = await loadLatestCatalog()
      const current = voiceSettingsRef.current
      const selectedProvider = latestCatalog.find((m) => m.id === current.sttModel)?.provider
      updateVoiceSettings({
        ...(providerId === 'openai' ? { openAiApiKeyConfigured: false } : {}),
        sttModel: selectedProvider === providerId ? '' : current.sttModel
      })
      // Why: the key is already removed; a failed state refresh must not read as a removal error.
      await Promise.resolve(refreshModelStates()).catch(() => {})
      toast.success(
        translate(
          'auto.components.settings.VoicePane.cloudKeyRemoved',
          '{{provider}} API key removed',
          { provider: providerLabel }
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.VoicePane.cloudKeyRemoveFailed',
          'Could not remove the {{provider}} API key',
          { provider: providerLabel }
        ),
        { description: describeSpeechIpcError(error) }
      )
    }
  }

  const keyDialogProvider = keyDialog ? getCloudSpeechProvider(keyDialog.providerId) : null

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
        onOpenCloudKeyDialog={openKeyDialog}
        onRefreshModelStates={refreshModelStates}
      />

      <Separator />

      <VoiceTranscriptionLanguageSetting
        voiceSettings={voiceSettings}
        selectedModel={catalog.find((model) => model.id === voiceSettings.sttModel)}
        onUpdateVoiceSettings={updateVoiceSettings}
      />

      <CloudSpeechProvidersSection
        keys={cloudKeys}
        onConfigure={(providerId) => openKeyDialog(providerId, null)}
        onClear={(providerId) => void clearCloudKey(providerId)}
      />

      <CloudSpeechProviderKeyDialog
        key={keyDialogSession}
        open={keyDialogOpen}
        provider={keyDialogProvider}
        status={keyDialog ? cloudKeys.statusById[keyDialog.providerId] : undefined}
        pending={keyDialog ? cloudKeys.pendingById[keyDialog.providerId] === true : false}
        onOpenChange={setKeyDialogOpen}
        onSave={saveCloudKey}
      />
    </div>
  )
}
