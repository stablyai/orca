import { Check, Cloud, Download, Loader2, Trash2 } from 'lucide-react'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type VoiceSpeechModelMenuItemProps = {
  manifest: SpeechModelManifest
  state: SpeechModelState | undefined
  isActive: boolean
  deletePending: boolean
  onSelect: (event: Event) => void
  onDelete: () => void
}

const PILL_CLASS = 'rounded-full px-1 py-px text-[10px] leading-none'

function ModelPills({ manifest }: { manifest: SpeechModelManifest }): React.JSX.Element {
  const isCloud = manifest.provider !== 'local'
  return (
    <>
      {isCloud && manifest.realtime ? (
        <span
          className={cn(
            PILL_CLASS,
            'inline-flex items-center gap-0.5 bg-foreground/10 text-foreground'
          )}
        >
          <span className="size-1 rounded-full bg-status-success" />
          {translate('auto.components.settings.VoiceSpeechModelMenuItem.live', 'live')}
        </span>
      ) : null}
      {isCloud ? null : (
        <span className={cn(PILL_CLASS, 'bg-muted text-muted-foreground')}>
          {manifest.streaming
            ? translate('auto.components.settings.VoicePane.d504ab05f0', 'streaming')
            : translate('auto.components.settings.VoicePane.8f4d2a51d7', 'offline')}
        </span>
      )}
      {manifest.recommended ? (
        <span className={cn(PILL_CLASS, 'bg-status-success-background text-status-success')}>
          {translate('auto.components.settings.VoicePane.1ba81c0ff0', 'recommended')}
        </span>
      ) : null}
    </>
  )
}

function describeModelMeta(
  manifest: SpeechModelManifest,
  state: SpeechModelState | undefined
): string | null {
  const isDownloading = state?.status === 'downloading' || state?.status === 'extracting'
  if (isDownloading && state?.progress !== undefined) {
    return state.status === 'extracting'
      ? translate('auto.components.settings.VoicePane.61a16c8141', 'Extracting...')
      : `${Math.round(state.progress * 100)}%`
  }
  if (manifest.provider !== 'local' || !manifest.sizeBytes) {
    return null
  }
  return translate('auto.components.settings.VoicePane.91980ce124', '{{value0}} MB', {
    value0: Math.round(manifest.sizeBytes / 1_000_000)
  })
}

export function VoiceSpeechModelMenuItem({
  manifest,
  state,
  isActive,
  deletePending,
  onSelect,
  onDelete
}: VoiceSpeechModelMenuItemProps): React.JSX.Element {
  const isReady = state?.status === 'ready'
  const isDownloading = state?.status === 'downloading' || state?.status === 'extracting'
  const isCloud = manifest.provider !== 'local'

  return (
    <DropdownMenuItem disabled={isDownloading} onSelect={onSelect} className="group">
      <div
        className={cn(
          'flex w-full items-center gap-2.5 py-1',
          !isReady && !isDownloading && 'opacity-50'
        )}
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
            <ModelPills manifest={manifest} />
            <span className="text-[10px] text-muted-foreground/60">
              {describeModelMeta(manifest, state)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
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
              if (!deletePending) {
                onDelete()
              }
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
          <span className="flex shrink-0 items-center p-1 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover:opacity-100">
            <Download className="size-3" />
          </span>
        ) : null}
      </div>
    </DropdownMenuItem>
  )
}
