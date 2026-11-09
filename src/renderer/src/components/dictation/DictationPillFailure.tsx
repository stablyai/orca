import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { CircleAlert, X } from 'lucide-react'
import { dispatchDictationControl } from './dictation-control-events'
import { openVoiceSettings, type DictationFailureKind } from './dictation-toasts'

/** The pill's ✕: cancels a dictation, or discards a failed one's recording. */
export function DictationPillCloseButton({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={() => dispatchDictationControl('cancel')}
        >
          <X className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The error pill's row: it keeps the failed recording until Retry, ✕ or the next dictation. */
export function DictationPillFailure({ kind }: { kind: DictationFailureKind }) {
  const t = useTranslate()
  const discardLabel = t(
    'auto.components.dictation.DictationPillFailure.discard',
    'Discard recording'
  )
  const message =
    kind === 'settings'
      ? t(
          'auto.components.dictation.DictationPillFailure.modelFailed',
          "Speech model couldn't load."
        )
      : t(
          'auto.components.dictation.DictationPillFailure.transcribeFailed',
          "Couldn't transcribe. Recording kept."
        )

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </span>
      <DictationPillCloseButton label={discardLabel} />
      <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
      <span aria-hidden className="min-w-0 flex-1 truncate">
        {message}
      </span>
      {kind === 'settings' ? (
        <Button type="button" variant="ghost" size="xs" onClick={openVoiceSettings}>
          {t('auto.components.dictation.DictationPillFailure.openSettings', 'Open settings')}
        </Button>
      ) : null}
      <Button type="button" size="xs" onClick={() => dispatchDictationControl('retry')}>
        {t('auto.components.dictation.DictationPillFailure.retry', 'Retry')}
      </Button>
    </>
  )
}
