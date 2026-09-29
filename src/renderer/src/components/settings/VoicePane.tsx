import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
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
import {
  cloudTranscriptionConfiguredUpdate,
  getCloudTranscriptionKeyApi,
  getCloudTranscriptionProviderLabel,
  type CloudTranscriptionProvider
} from './cloud-transcription-provider'
import { translate } from '@/i18n/i18n'

export { handleVoiceDictationToggle }

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  // Why: a stable fallback prevents the fetch effect from repeating on every parent render.
  const [defaultVoiceSettings] = useState(getDefaultVoiceSettings)
  const voiceSettings = settings.voice ?? defaultVoiceSettings
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])
  const [permissionPending, setPermissionPending] = useState(false)
  const [keyDialog, setKeyDialog] = useState<{
    provider: CloudTranscriptionProvider
    modelId: string | null
  } | null>(null)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [keyPending, setKeyPending] = useState(false)
  const keyChangeEpochRef = useRef(0)
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
    (updates: Partial<VoiceSettings>): void | Promise<void> => {
      voiceSettingsRef.current = { ...voiceSettingsRef.current, ...updates }
      return updateSettings({ voice: voiceSettingsRef.current })
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
    return () => {
      cancelled = true
    }
  }, [refreshModelStates])

  useEffect(() => {
    if (keyPending) {
      return
    }
    let cancelled = false
    const keyChangeEpoch = keyChangeEpochRef.current
    for (const provider of ['openai', 'openrouter'] as const) {
      const configured =
        provider === 'openai'
          ? voiceSettings.openAiApiKeyConfigured
          : (voiceSettings.openRouterApiKeyConfigured ?? false)
      void getCloudTranscriptionKeyApi(provider)
        .getStatus()
        .then(async (status) => {
          if (
            !cancelled &&
            keyChangeEpoch === keyChangeEpochRef.current &&
            status.configured !== configured
          ) {
            await updateVoiceSettings(
              cloudTranscriptionConfiguredUpdate(provider, status.configured)
            )
            await refreshModelStates()
          }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [
    keyPending,
    updateVoiceSettings,
    refreshModelStates,
    voiceSettings.openAiApiKeyConfigured,
    voiceSettings.openRouterApiKeyConfigured
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

  const openKeyDialog = (
    provider: CloudTranscriptionProvider,
    modelId: string | null = null
  ): void => {
    if (!keyPending) {
      setApiKeyDraft('')
      setKeyDialog({ provider, modelId })
    }
  }
  const closeKeyDialog = (): void => {
    setKeyDialog(null)
    setApiKeyDraft('')
  }
  const keyConfigured = (provider: CloudTranscriptionProvider): boolean =>
    provider === 'openai'
      ? voiceSettings.openAiApiKeyConfigured
      : (voiceSettings.openRouterApiKeyConfigured ?? false)

  const changeKey = async (
    provider: CloudTranscriptionProvider,
    operation: 'save' | 'clear'
  ): Promise<void> => {
    if (keyPending) {
      return
    }
    setKeyPending(true)
    const api = getCloudTranscriptionKeyApi(provider)
    const providerLabel = getCloudTranscriptionProviderLabel(provider)
    try {
      // Remove credentials without metadata; clear selections only with known provider ownership.
      const currentCatalog =
        operation === 'clear' && catalog.length === 0
          ? await window.api.speech.getCatalog().catch(() => catalog)
          : catalog
      await (operation === 'save' ? api.save(apiKeyDraft) : api.clear())
      keyChangeEpochRef.current += 1
      const currentModelId = voiceSettingsRef.current.sttModel
      const clearSelectedModel =
        operation === 'clear' &&
        currentCatalog.some((model) => model.id === currentModelId && model.provider === provider)
      await updateVoiceSettings({
        ...cloudTranscriptionConfiguredUpdate(provider, operation === 'save'),
        ...(clearSelectedModel
          ? { sttModel: '' }
          : operation === 'save' && keyDialog?.modelId
            ? { sttModel: keyDialog.modelId }
            : {})
      })
      await refreshModelStates()
      closeKeyDialog()
      toast.success(
        operation === 'save'
          ? translate('settings.voice.cloudKeySaved', '{{provider}} API key saved', {
              provider: providerLabel
            })
          : translate('settings.voice.cloudKeyCleared', '{{provider}} API key cleared', {
              provider: providerLabel
            })
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('settings.voice.cloudKeyFailed', 'Failed to update {{provider}} API key', {
              provider: providerLabel
            })
      )
    } finally {
      if (mountedRef.current) {
        setKeyPending(false)
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
        onOpenCloudDialog={openKeyDialog}
        onRefreshModelStates={refreshModelStates}
      />

      {(['openai', 'openrouter'] as const).map((provider) => (
        <Fragment key={provider}>
          <Separator />
          <CloudTranscriptionSettingsRow
            provider={provider}
            configured={keyConfigured(provider)}
            disabled={keyPending}
            onConfigure={() => openKeyDialog(provider)}
            onClear={() => void changeKey(provider, 'clear')}
          />
        </Fragment>
      ))}
      {keyDialog && (
        <CloudTranscriptionKeyDialog
          open
          provider={keyDialog.provider}
          configured={keyConfigured(keyDialog.provider)}
          apiKeyDraft={apiKeyDraft}
          pending={keyPending}
          onOpenChange={closeKeyDialog}
          onApiKeyDraftChange={setApiKeyDraft}
          onSave={() => void changeKey(keyDialog.provider, 'save')}
          onClear={() => void changeKey(keyDialog.provider, 'clear')}
        />
      )}
    </div>
  )
}
