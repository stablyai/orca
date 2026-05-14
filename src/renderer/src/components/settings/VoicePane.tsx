import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Download, Trash2, Loader2, ChevronDown, Check } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'

const IS_MAC = navigator.userAgent.includes('Mac')
const SHORTCUT_LABEL = IS_MAC ? '\u2318E' : 'Ctrl+E'

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
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])

  useEffect(() => {
    refreshModelStates()
    window.api.speech
      .getCatalog()
      .then(setCatalog)
      .catch(() => {})
  }, [refreshModelStates])

  useEffect(() => {
    const cleanup = window.api.speech.onDownloadProgress(() => {
      refreshModelStates()
    })
    return cleanup
  }, [refreshModelStates])

  const updateVoiceSettings = (updates: Partial<GlobalSettings['voice']>): void => {
    updateSettings({
      voice: {
        ...voiceSettings,
        ...updates
      }
    })
  }

  const getModelState = (id: string): SpeechModelState | undefined =>
    modelStates.find((s) => s.id === id)

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const selectedModelState = voiceSettings.sttModel
    ? getModelState(voiceSettings.sttModel)
    : undefined
  const selectedIsReady = selectedModelState?.status === 'ready'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 px-1 py-2">
        <div className="space-y-0.5">
          <Label>Enable Voice Dictation</Label>
          <p className="text-xs text-muted-foreground">
            Press {SHORTCUT_LABEL} to dictate text into any focused pane.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={voiceSettings.enabled}
          aria-label="Enable Voice Dictation"
          onClick={() => updateVoiceSettings({ enabled: !voiceSettings.enabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            voiceSettings.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              voiceSettings.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 px-1 py-2">
        <div className="space-y-0.5">
          <Label>Dictation Mode</Label>
          <p className="text-xs text-muted-foreground">
            Toggle: press {SHORTCUT_LABEL} once to start, again to stop. Hold: dictate while{' '}
            {SHORTCUT_LABEL} is held.
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

      <div className="flex items-center justify-between gap-4 px-1 py-2">
        <div className="space-y-0.5">
          <Label>Speech Model</Label>
          <p className="text-xs text-muted-foreground">
            {selectedModel && selectedIsReady
              ? `${selectedModel.label} — ${selectedModel.description}`
              : 'Select and download a model to enable dictation.'}
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
              const sizeMb = Math.round(manifest.sizeBytes / 1_000_000)

              return (
                <DropdownMenuItem
                  key={manifest.id}
                  disabled={isDownloading}
                  onSelect={() => {
                    if (isReady) {
                      updateVoiceSettings({ sttModel: manifest.id })
                    } else if (!isDownloading) {
                      void window.api.speech
                        .downloadModel(manifest.id)
                        .catch(() => toast.error('Failed to download model.'))
                    }
                  }}
                  className={`group flex items-center gap-2.5 py-2.5 ${
                    !isReady && !isDownloading ? 'opacity-50' : ''
                  }`}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {isActive && isReady ? (
                      <Check className="size-3.5" />
                    ) : isDownloading ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium">{manifest.label}</span>
                      <span className="text-[10px] px-1 py-px rounded-full leading-none bg-muted text-muted-foreground">
                        {manifest.streaming ? 'streaming' : 'offline'}
                      </span>
                      {manifest.recommended && (
                        <span className="text-[10px] px-1 py-px rounded-full leading-none bg-emerald-500/10 text-emerald-500">
                          recommended
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground/60">
                        {isDownloading && mState?.progress !== undefined
                          ? mState.status === 'extracting'
                            ? 'Extracting...'
                            : `${Math.round(mState.progress * 100)}%`
                          : `${sizeMb} MB`}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                      {manifest.description}
                    </p>
                  </div>
                  {isReady && !isActive ? (
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
                  ) : !isReady && !isDownloading ? (
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
    </div>
  )
}
