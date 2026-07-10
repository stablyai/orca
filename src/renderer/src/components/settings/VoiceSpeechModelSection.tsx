import { useState } from 'react'
import { toast } from 'sonner'
import type { VoiceSettings } from '../../../../shared/speech-types'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Cloud, Download, Trash2, Loader2, ChevronDown, Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type VoiceSpeechModelSectionProps = {
  voiceSettings: VoiceSettings
  catalog: SpeechModelManifest[]
  modelStates: SpeechModelState[]
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  onOpenOpenAiDialog: (modelId: string) => void
  onRefreshModelStates: () => void
}

export function VoiceSpeechModelSection({
  voiceSettings,
  catalog,
  modelStates,
  onUpdateVoiceSettings,
  onOpenOpenAiDialog,
  onRefreshModelStates
}: VoiceSpeechModelSectionProps): React.JSX.Element {
  const [pendingDeleteModelIds, setPendingDeleteModelIds] = useState<Set<string>>(() => new Set())
  const getModelState = (id: string): SpeechModelState | undefined =>
    modelStates.find((s) => s.id === id)

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const selectedModelState = voiceSettings.sttModel
    ? getModelState(voiceSettings.sttModel)
    : undefined
  const selectedIsReady = selectedModelState?.status === 'ready'

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>{translate('auto.components.settings.VoicePane.43fd4f454b', 'Speech Model')}</Label>
        <p className="text-xs text-muted-foreground">
          {selectedModel && selectedIsReady
            ? `${selectedModel.label} — ${selectedModel.description}`
            : translate(
                'auto.components.settings.VoicePane.e24f7d43d2',
                'Select a speech model. Local models run offline; cloud models require an API key.'
              )}
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
            {selectedModel && selectedIsReady
              ? selectedModel.label
              : translate('auto.components.settings.VoicePane.fbe5990716', 'Select Model')}
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
            const deletePending = pendingDeleteModelIds.has(manifest.id)
            const sizeMb = manifest.sizeBytes ? Math.round(manifest.sizeBytes / 1_000_000) : null

            return (
              <DropdownMenuItem
                key={manifest.id}
                disabled={isDownloading}
                onSelect={(event) => {
                  if (isReady) {
                    onUpdateVoiceSettings({ sttModel: manifest.id })
                  } else if (isCloud) {
                    onOpenOpenAiDialog(manifest.id)
                  } else if (!isDownloading) {
                    // Why: download progress appears in this menu, so starting one should not dismiss it.
                    event.preventDefault()
                    void window.api.speech
                      .downloadModel(manifest.id)
                      .catch(() =>
                        toast.error(
                          translate(
                            'auto.components.settings.VoicePane.cfde55c7b0',
                            'Failed to download model.'
                          )
                        )
                      )
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
                        {manifest.streaming
                          ? translate('auto.components.settings.VoicePane.d504ab05f0', 'streaming')
                          : translate('auto.components.settings.VoicePane.8f4d2a51d7', 'offline')}
                      </span>
                    )}
                    {manifest.recommended && (
                      <span className="text-[10px] px-1 py-px rounded-full leading-none bg-status-success-background text-status-success">
                        {translate('auto.components.settings.VoicePane.1ba81c0ff0', 'recommended')}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/60">
                      {isDownloading && mState?.progress !== undefined
                        ? mState.status === 'extracting'
                          ? translate(
                              'auto.components.settings.VoicePane.61a16c8141',
                              'Extracting...'
                            )
                          : `${Math.round(mState.progress * 100)}%`
                        : isCloud
                          ? null
                          : translate(
                              'auto.components.settings.VoicePane.91980ce124',
                              '{{value0}} MB',
                              { value0: sizeMb }
                            )}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    {manifest.description}
                  </p>
                </div>
                {!isCloud && isReady ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'auto.components.settings.VoicePane.6fa734ed95',
                      'Delete {{value0}}',
                      {
                        value0: manifest.label
                      }
                    )}
                    disabled={deletePending}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      if (deletePending) {
                        return
                      }
                      setPendingDeleteModelIds((prev) => {
                        const next = new Set(prev)
                        next.add(manifest.id)
                        return next
                      })
                      void window.api.speech
                        .deleteModel(manifest.id)
                        .then(onRefreshModelStates)
                        .catch(() =>
                          toast.error(
                            translate(
                              'auto.components.settings.VoicePane.68de13f72c',
                              'Failed to delete model.'
                            )
                          )
                        )
                        .finally(() =>
                          setPendingDeleteModelIds((prev) => {
                            const next = new Set(prev)
                            next.delete(manifest.id)
                            return next
                          })
                        )
                    }}
                    className="shrink-0 text-muted-foreground can-hover:opacity-0 group-hover:opacity-100 hover:text-destructive disabled:opacity-60 disabled:hover:text-muted-foreground"
                  >
                    {deletePending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </Button>
                ) : !isCloud && !isReady && !isDownloading ? (
                  <span className="shrink-0 p-1 text-muted-foreground can-hover:opacity-0 group-hover:opacity-100 transition-opacity">
                    <Download className="size-3" />
                  </span>
                ) : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
