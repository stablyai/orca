import { Check, Loader2, Trash2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Button } from '../../ui/button'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import { isSpeechModelDownloading, type VoiceSpeechModelRowData } from './voice-speech-model-rows'
import { speechModelDescription } from './voice-speech-model-descriptions'
import { VoiceSpeechModelQuality } from './VoiceSpeechModelQuality'

export type VoiceSpeechModelRowActions = {
  onUse: (modelId: string) => void
  onDownload: (modelId: string) => void
  onCancelDownload: (modelId: string) => void
  onDelete: (modelId: string) => void
  onSetUpCloud: (modelId: string) => void
  /** Selects, downloads and turns on the recommended model. */
  onSetUp: () => void
}

type VoiceSpeechModelRowProps = VoiceSpeechModelRowActions & {
  row: VoiceSpeechModelRowData
  active: boolean
  recommended: boolean
  setUpPending: boolean
  deletePending: boolean
}

// Columns shared with the header through subgrid, so every row's button gets the widest label's width.
export const SPEECH_MODEL_GRID_COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_minmax(6.5rem,max-content)_minmax(4.5rem,auto)_1.5rem_auto] @max-lg:grid-cols-[minmax(0,1fr)_1.5rem_auto]'
export const SPEECH_MODEL_WIDE_ONLY = '@max-lg:hidden'

export function VoiceSpeechModelRow({
  row: { manifest, state, quality },
  active,
  recommended,
  setUpPending,
  deletePending,
  onUse,
  onDownload,
  onCancelDownload,
  onDelete,
  onSetUpCloud,
  onSetUp
}: VoiceSpeechModelRowProps): React.JSX.Element {
  const t = useTranslate()
  const isCloud = manifest.provider !== 'local'
  const retired = quality === null
  const ready = state?.status === 'ready'
  const downloading = isSpeechModelDownloading(state)
  const needsUpdate = state?.needsUpdate === true && !downloading
  const totalMb = Math.round((manifest.sizeBytes ?? 0) / 1_000_000)

  let subline: React.ReactNode = speechModelDescription(manifest, t)
  if (retired) {
    subline = t(
      'components.settings.voice.models.retired',
      'No longer offered. Delete it to free up space.'
    )
  } else if (state?.status === 'extracting') {
    subline = t('auto.components.settings.VoicePane.61a16c8141', 'Extracting...')
  } else if (downloading) {
    subline = t(
      'components.settings.voice.models.downloadingProgress',
      'Downloading, {{done}} of {{total}} MB ({{percent}}%)',
      {
        done: Math.round((state?.progress ?? 0) * totalMb),
        total: totalMb,
        percent: Math.round((state?.progress ?? 0) * 100)
      }
    )
  } else if (needsUpdate) {
    subline = t(
      'components.settings.voice.models.needsUpdate',
      'Needs a one-time download for the faster engine.'
    )
  }

  const button = (
    label: string,
    onClick: () => void,
    { primary = false, disabled = false } = {}
  ): React.JSX.Element => (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      size="xs"
      className="w-full"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  )

  let action: React.ReactNode
  if (retired) {
    action = button(
      t('components.settings.voice.models.delete', 'Delete'),
      () => onDelete(manifest.id),
      { disabled: deletePending }
    )
  } else if (downloading) {
    action = button(t('speechModelUpdate.cancel', 'Cancel'), () => onCancelDownload(manifest.id))
  } else if (needsUpdate) {
    action = button(t('speechModelUpdate.update', 'Update'), () => onDownload(manifest.id), {
      primary: true
    })
  } else if (ready && active) {
    action = (
      <span className="inline-flex h-6 w-full items-center justify-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" />
        {t('components.settings.voice.models.inUse', 'In use')}
      </span>
    )
  } else if (ready) {
    action = button(t('components.settings.voice.models.use', 'Use'), () => onUse(manifest.id))
  } else if (isCloud) {
    action = button(
      manifest.provider === 'openai'
        ? t('auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61', 'Add API key')
        : t('components.settings.voice.models.setUpCloud', 'Set up'),
      () => onSetUpCloud(manifest.id)
    )
  } else if (recommended) {
    action = button(t('components.settings.voice.models.download', 'Download'), onSetUp, {
      primary: true,
      disabled: setUpPending
    })
  } else {
    action = button(t('components.settings.voice.models.download', 'Download'), () =>
      onDownload(manifest.id)
    )
  }

  // Deletable files: always offered on the model in use, on hover for the rest.
  const deletable = !isCloud && !retired && !downloading && (ready || needsUpdate)

  return (
    <div
      role="listitem"
      data-settings-row=""
      data-current={active ? 'true' : undefined}
      className={cn(
        'group/model col-span-full grid grid-cols-subgrid items-center gap-x-3 px-5 py-2.5',
        active && 'bg-accent',
        quality?.kind === 'unsupported' && 'opacity-60'
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{manifest.label}</span>
          {recommended ? (
            <SettingsBadge>
              {t('components.settings.voice.models.recommended', 'Recommended')}
            </SettingsBadge>
          ) : null}
        </div>
        {subline ? <div className="text-xs text-muted-foreground">{subline}</div> : null}
      </div>
      <div className={cn('min-w-0 max-w-36 text-xs', SPEECH_MODEL_WIDE_ONLY)}>
        {quality ? <VoiceSpeechModelQuality quality={quality} /> : null}
      </div>
      <div
        className={cn(
          'text-right text-xs tabular-nums text-muted-foreground',
          SPEECH_MODEL_WIDE_ONLY
        )}
      >
        {isCloud || retired
          ? null
          : t('auto.components.settings.VoicePane.91980ce124', '{{value0}} MB', {
              value0: totalMb
            })}
      </div>
      <div
        className={cn(
          '-mr-2 flex justify-end',
          !active &&
            !deletePending &&
            'opacity-0 group-hover/model:opacity-100 focus-within:opacity-100'
        )}
      >
        {deletable ? (
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
        ) : null}
      </div>
      <div className="flex justify-center">{action}</div>
    </div>
  )
}
