import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Cloud, Download, Trash2, Loader2, ChevronDown, Check } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { OpenAiTranscriptionKeyDialog } from './OpenAiTranscriptionKeyDialog'
import { OpenAiTranscriptionSettingsRow } from './OpenAiTranscriptionSettingsRow'
import { handleVoiceDictationToggle } from './voice-dictation-toggle'
import { matchesSettingsSearch } from './settings-search'
import { OPENAI_TRANSCRIPTION_SEARCH_ENTRY } from './voice-pane-search'

export { handleVoiceDictationToggle }

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  // Why: voice was made optional on GlobalSettings to keep older test fixtures
  // and pre-voice profiles type-compatible. Persistence merges defaults at
  // load time, so this fallback only matters during a brief render window
  // before fetchSettings completes (or in test contexts).
  const voiceSettings = settings.voice ?? getDefaultVoiceSettings()
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery ?? '')
  const shortcutLabel = useShortcutLabel('voice.dictation')
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])
  const [permissionPending, setPermissionPending] = useState(false)
  const [openAiDialogOpen, setOpenAiDialogOpen] = useState(false)
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('')
  const [openAiKeyPending, setOpenAiKeyPending] = useState(false)
  const [pendingCloudModelId, setPendingCloudModelId] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const handlePaneRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: the microphone permission prompt can resolve after Settings closes;
    // the pane ref gives that completion a stale-write guard without an Effect.
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
      notifyPermissionGranted: () => toast.success('Microphone permission granted'),
      notifyPermissionOpenedSystemSettings: () =>
        toast.message(
          'Opened macOS Privacy & Security. Enable dictation again after granting access.'
        ),
      notifyPermissionRequired: () =>
        toast.message('Microphone permission is required before enabling voice dictation.'),
      notifyPermissionRequestFailed: () =>
        toast.error('Could not request microphone permission. Voice dictation was not enabled.')
    })
  }

  const getModelState = (id: string): SpeechModelState | undefined =>
    modelStates.find((s) => s.id === id)

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const selectedModelState = voiceSettings.sttModel
    ? getModelState(voiceSettings.sttModel)
    : undefined
  const selectedIsReady = selectedModelState?.status === 'ready'
  const showOpenAiSettingsRow =
    voiceSettings.openAiApiKeyConfigured ||
    selectedModel?.provider === 'openai' ||
    (settingsSearchQuery.trim() !== '' &&
      matchesSettingsSearch(settingsSearchQuery, OPENAI_TRANSCRIPTION_SEARCH_ENTRY))

  const openOpenAiDialog = (modelId: string | null = null): void => {
    setPendingCloudModelId(modelId)
    setOpenAiApiKeyDraft('')
    setOpenAiDialogOpen(true)
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
      toast.success('OpenAI API key saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save OpenAI API key')
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
      toast.success('OpenAI API key cleared')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear OpenAI API key')
    } finally {
      if (mountedRef.current) {
        setOpenAiKeyPending(false)
      }
    }
  }

  return (
    <div ref={handlePaneRef} className="space-y-1">
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>Enable Voice Dictation</Label>
          <p className="text-xs text-muted-foreground">
            Press {shortcutLabel} to dictate text into any focused pane.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={voiceSettings.enabled}
          aria-label="Enable Voice Dictation"
          aria-busy={permissionPending}
          disabled={permissionPending}
          onClick={() => void toggleVoiceDictation()}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            voiceSettings.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          } ${permissionPending ? 'cursor-wait opacity-70' : ''}`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              voiceSettings.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>Dictation Mode</Label>
          <p className="text-xs text-muted-foreground">
            Toggle: press {shortcutLabel} once to start, again to stop. Hold: dictate while{' '}
            {shortcutLabel} is held.
          </p>
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5">
          {(['toggle', 'hold'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => updateVoiceSettings({ dictationMode: mode })}
              disabled={!voiceSettings.enabled}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                voiceSettings.dictationMode === mode
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              } ${!voiceSettings.enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {mode === 'toggle' ? 'Toggle' : 'Hold'}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>Speech Model</Label>
          <p className="text-xs text-muted-foreground">
            {selectedModel && selectedIsReady
              ? `${selectedModel.label} — ${selectedModel.description}`
              : 'Select a speech model. Local models run offline; cloud models require an API key.'}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!voiceSettings.enabled}
              className="shrink-0 gap-1.5"
            >
              {selectedModel && selectedIsReady ? selectedModel.label : 'Select Model'}
              <ChevronDown className="size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-96">
            {catalog.map((manifest) => {
              const mState = getModelState(manifest.id)
              const isReady = mState?.status === 'ready'
              const isDownloading =
                mState?.status === 'downloading' || mState?.status === 'extracting'
              const isActive = voiceSettings.sttModel === manifest.id
              const isCloud = manifest.provider === 'openai'
              const sizeMb = manifest.sizeBytes ? Math.round(manifest.sizeBytes / 1_000_000) : null

              return (
                <DropdownMenuItem
                  key={manifest.id}
                  disabled={isDownloading}
                  onSelect={() => {
                    if (isReady) {
                      updateVoiceSettings({ sttModel: manifest.id })
                    } else if (isCloud) {
                      openOpenAiDialog(manifest.id)
                    } else if (!isDownloading) {
                      void window.api.speech
                        .downloadModel(manifest.id)
                        .catch(() => toast.error('Failed to download model.'))
                    }
                  }}
                  className={`group flex items-center gap-2.5 py-2.5 ${
                    !isCloud && !isReady && !isDownloading ? 'opacity-50' : ''
                  }`}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {isActive && isReady ? (
                      <Check className="size-3.5" />
                    ) : isDownloading ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : isCloud ? (
                      <Cloud className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium">{manifest.label}</span>
                      {!isCloud && (
                        <span className="text-[10px] px-1 py-px rounded-full leading-none bg-muted text-muted-foreground">
                          {manifest.streaming ? 'streaming' : 'offline'}
                        </span>
                      )}
                      {manifest.recommended && (
                        <span className="text-[10px] px-1 py-px rounded-full leading-none bg-status-success-background text-status-success">
                          recommended
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground/60">
                        {isDownloading && mState?.progress !== undefined
                          ? mState.status === 'extracting'
                            ? 'Extracting...'
                            : `${Math.round(mState.progress * 100)}%`
                          : isCloud
                            ? null
                            : `${sizeMb} MB`}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                      {manifest.description}
                    </p>
                  </div>
                  {!isCloud && isReady && !isActive ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.api.speech
                          .deleteModel(manifest.id)
                          .then(refreshModelStates)
                          .catch(() => toast.error('Failed to delete model.'))
                      }}
                      className="shrink-0 p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all rounded"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  ) : !isCloud && !isReady && !isDownloading ? (
                    <span className="shrink-0 p-1 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      <Download className="size-3" />
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

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
