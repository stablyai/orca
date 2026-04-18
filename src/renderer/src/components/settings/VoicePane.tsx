import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Download, Trash2, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import type { SettingsSearchEntry } from './settings-search'

export const VOICE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Voice Dictation',
    description: 'Master toggle for voice dictation features.',
    keywords: ['voice', 'dictation', 'speech', 'microphone', 'stt']
  },
  {
    title: 'Dictation Mode',
    description: 'Toggle or hold-to-talk dictation behavior.',
    keywords: ['voice', 'dictation', 'mode', 'toggle', 'hold', 'push to talk']
  },
  {
    title: 'Speech Model',
    description: 'Select which speech-to-text model to use for dictation.',
    keywords: ['voice', 'model', 'speech', 'stt', 'download']
  },
  {
    title: 'Terminal Confirm Before Insert',
    description: 'Show a preview before injecting dictated text into the terminal.',
    keywords: ['voice', 'terminal', 'confirm', 'preview']
  }
]

const IS_MAC = navigator.userAgent.includes('Mac')
const SHORTCUT_LABEL = IS_MAC ? '\u2318E' : 'Ctrl+E'

type VoicePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function VoicePane({ settings, updateSettings }: VoicePaneProps): React.JSX.Element {
  const voiceSettings = settings.voice
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const [catalog, setCatalog] = useState<SpeechModelManifest[]>([])

  useEffect(() => {
    refreshModelStates()
    window.api.speech.getCatalog().then(setCatalog)
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
            Toggle: press once to start, again to stop. Hold: dictate while key is held.
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
          <Label>Terminal Confirm Before Insert</Label>
          <p className="text-xs text-muted-foreground">
            Show a preview before injecting dictated text into the terminal.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={voiceSettings.terminalConfirmBeforeInsert}
          aria-label="Terminal Confirm Before Insert"
          disabled={!voiceSettings.enabled}
          onClick={() =>
            updateVoiceSettings({
              terminalConfirmBeforeInsert: !voiceSettings.terminalConfirmBeforeInsert
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
            voiceSettings.terminalConfirmBeforeInsert ? 'bg-foreground' : 'bg-muted-foreground/30'
          } ${!voiceSettings.enabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              voiceSettings.terminalConfirmBeforeInsert ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Separator />

      <div className="px-1 py-3">
        <Label className="mb-2 block">Speech Models</Label>
        <p className="text-xs text-muted-foreground mb-3">
          Download a model to enable voice dictation. Models run locally on your device.
        </p>
        <div className="space-y-2">
          {catalog.map((manifest) => {
            const state = modelStates.find((s) => s.id === manifest.id)
            return (
              <ModelCard
                key={manifest.id}
                manifest={manifest}
                state={state}
                isSelected={voiceSettings.sttModel === manifest.id}
                onSelect={() => updateVoiceSettings({ sttModel: manifest.id })}
                onDownload={() => void window.api.speech.downloadModel(manifest.id)}
                onCancel={() => void window.api.speech.cancelDownload(manifest.id)}
                onDelete={() =>
                  void window.api.speech.deleteModel(manifest.id).then(refreshModelStates)
                }
                disabled={!voiceSettings.enabled}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

type ModelCardProps = {
  manifest: SpeechModelManifest
  state?: SpeechModelState
  isSelected: boolean
  onSelect: () => void
  onDownload: () => void
  onCancel: () => void
  onDelete: () => void
  disabled: boolean
}

function ModelCard({
  manifest,
  state,
  isSelected,
  onSelect,
  onDownload,
  onCancel,
  onDelete,
  disabled
}: ModelCardProps): React.JSX.Element {
  const status = state?.status ?? 'not-downloaded'
  const sizeMb = Math.round(manifest.sizeBytes / 1_000_000)
  const isReady = status === 'ready'
  const isDownloading = status === 'downloading' || status === 'extracting'

  return (
    <button
      type="button"
      disabled={
        disabled || isDownloading || (!isReady && status !== 'not-downloaded' && status !== 'error')
      }
      onClick={() => {
        if (isReady && !isSelected) {
          onSelect()
        }
      }}
      className={`group relative w-full text-left rounded-lg border p-3 transition-colors ${
        isSelected && isReady
          ? 'border-foreground/20 bg-accent/15'
          : isReady
            ? 'border-border/70 hover:border-border hover:bg-accent/8'
            : 'border-border/70'
      } ${disabled ? 'opacity-50' : ''} ${isReady && !isSelected ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            {isReady && (
              <span
                className={`size-2 rounded-full shrink-0 transition-colors ${
                  isSelected ? 'bg-green-500' : 'bg-muted-foreground/30'
                }`}
              />
            )}
            <span className="text-sm font-medium">{manifest.label}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                manifest.streaming
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {manifest.streaming ? 'streaming' : 'offline'}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              {manifest.language}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">{manifest.description}</p>

          <span className="text-[10px] text-muted-foreground/60">{sizeMb} MB</span>

          {isDownloading && state?.progress !== undefined && (
            <div className="pt-1 space-y-1">
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-foreground/60 transition-all"
                  style={{ width: `${Math.round(state.progress * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">
                {status === 'extracting'
                  ? 'Extracting...'
                  : `Downloading... ${Math.round(state.progress * 100)}%`}
              </span>
            </div>
          )}

          {status === 'error' && state?.error && (
            <span className="text-[10px] text-destructive">{state.error}</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {(status === 'not-downloaded' || status === 'error') && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onDownload}
              className="gap-1.5"
            >
              <Download className="size-3" />
              Download
            </Button>
          )}

          {isDownloading && (
            <Button variant="outline" size="sm" onClick={onCancel} className="gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Cancel
            </Button>
          )}

          {isReady && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={onDelete}
              className="gap-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </button>
  )
}
