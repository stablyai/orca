import { Check, Download, Loader2, Trash2, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
import type { VoiceSpeechModelRowData } from './voice-speech-model-rows'
import { VoiceSpeechModelQuality } from './VoiceSpeechModelQuality'

export type VoiceSpeechModelRowActions = {
  onUse: (modelId: string) => void
  onDownload: (modelId: string) => void
  onCancelDownload: (modelId: string) => void
  onDelete: (modelId: string) => void
  onSetUpCloud: (modelId: string) => void
}

type VoiceSpeechModelRowProps = VoiceSpeechModelRowActions & {
  row: VoiceSpeechModelRowData
  active: boolean
  deletePending: boolean
}

export function VoiceSpeechModelRow({
  row: { manifest, state, quality },
  active,
  deletePending,
  onUse,
  onDownload,
  onCancelDownload,
  onDelete,
  onSetUpCloud
}: VoiceSpeechModelRowProps): React.JSX.Element {
  const t = useTranslate()
  const isCloud = manifest.provider !== 'local'
  const retired = quality === null
  const ready = state?.status === 'ready'
  const downloading = state?.status === 'downloading' || state?.status === 'extracting'
  const needsUpdate = state?.needsUpdate === true && !downloading
  const totalMb = Math.round((manifest.sizeBytes ?? 0) / 1_000_000)
  const percent = Math.round((state?.progress ?? 0) * 100)

  const deleteButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t('auto.components.settings.VoicePane.6fa734ed95', 'Delete {{value0}}', {
        value0: manifest.label
      })}
      disabled={deletePending}
      onClick={() => onDelete(manifest.id)}
    >
      {deletePending ? <Loader2 className="animate-spin" /> : <Trash2 />}
    </Button>
  )

  let subline: React.ReactNode = null
  if (retired) {
    subline = t(
      'components.settings.voice.models.retired',
      'No longer offered. Delete it to free up space.'
    )
  } else if (state?.status === 'extracting') {
    subline = t('auto.components.settings.VoicePane.61a16c8141', 'Extracting...')
  } else if (downloading) {
    subline = t('speechModelUpdate.progress', '{{done}} of {{total}} MB', {
      done: Math.round((state?.progress ?? 0) * totalMb),
      total: totalMb
    })
  } else if (needsUpdate) {
    subline = (
      <span className="font-medium text-foreground">
        {t(
          'auto.components.settings.VoicePane.updateToFasterVersion',
          'Update to the faster version ({{value0}} MB)',
          { value0: totalMb }
        )}
      </span>
    )
  } else if (manifest.provider === 'openai') {
    subline = t('components.settings.voice.models.sendsToOpenAi', 'Sends your audio to OpenAI.')
  } else if (manifest.provider === 'openai-compatible') {
    subline = t(
      'components.settings.voice.models.sendsToCompatible',
      'Sends your audio to the service you set up.'
    )
  }

  let action: React.ReactNode
  if (retired) {
    action = (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={deletePending}
        onClick={() => onDelete(manifest.id)}
      >
        {deletePending ? <Loader2 className="animate-spin" /> : <Trash2 />}
        {t('components.settings.voice.models.delete', 'Delete')}
      </Button>
    )
  } else if (downloading) {
    action = (
      <>
        <Progress value={percent} className="h-1 w-16" />
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
          {percent}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('components.settings.voice.models.cancelDownload', 'Cancel download')}
          onClick={() => onCancelDownload(manifest.id)}
        >
          <X />
        </Button>
      </>
    )
  } else if (needsUpdate) {
    action = (
      <>
        <Button type="button" variant="outline" size="xs" onClick={() => onDownload(manifest.id)}>
          {t('speechModelUpdate.update', 'Update')}
        </Button>
        {deleteButton}
      </>
    )
  } else if (ready) {
    action = (
      <>
        {active ? (
          <span className="inline-flex h-6 items-center gap-1 px-2 text-xs text-muted-foreground">
            <Check className="size-3" />
            {t('components.settings.voice.models.inUse', 'In use')}
          </span>
        ) : (
          <Button type="button" variant="outline" size="xs" onClick={() => onUse(manifest.id)}>
            {t('components.settings.voice.models.use', 'Use')}
          </Button>
        )}
        {isCloud ? null : deleteButton}
      </>
    )
  } else if (isCloud) {
    action = (
      <Button type="button" variant="outline" size="xs" onClick={() => onSetUpCloud(manifest.id)}>
        {manifest.provider === 'openai'
          ? t('auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61', 'Add API key')
          : t('components.settings.voice.models.setUpCloud', 'Set up')}
      </Button>
    )
  } else {
    action = (
      <Button type="button" variant="ghost" size="xs" onClick={() => onDownload(manifest.id)}>
        <Download />
        {t('components.settings.voice.models.download', 'Download')}
      </Button>
    )
  }

  return (
    <div
      data-current={active ? 'true' : undefined}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_11rem_4.5rem_8.5rem] items-center gap-3 rounded-md px-2 py-2.5',
        active && 'bg-accent',
        quality?.kind === 'unsupported' && 'opacity-60'
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{manifest.label}</div>
        {subline ? <div className="text-xs text-muted-foreground">{subline}</div> : null}
      </div>
      <div className="min-w-0">
        {quality ? <VoiceSpeechModelQuality quality={quality} /> : null}
      </div>
      <div className="text-right text-xs tabular-nums text-muted-foreground">
        {isCloud
          ? t('components.settings.voice.models.cloud', 'Cloud')
          : retired
            ? null
            : t('auto.components.settings.VoicePane.91980ce124', '{{value0}} MB', {
                value0: totalMb
              })}
      </div>
      <div className="flex items-center justify-end gap-1">{action}</div>
    </div>
  )
}
