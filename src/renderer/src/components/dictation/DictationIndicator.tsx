import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Square } from 'lucide-react'
import { dispatchDictationControl } from './dictation-control-events'
import { DictationGrapes } from './DictationGrapes'
import { useDictationMeter } from './dictation-meter-store'

// captureLive: the mic is recording (and buffering) while the speech engine is still starting.
export function DictationIndicator({ captureLive }: { captureLive: boolean }) {
  const t = useTranslate()
  const dictationState = useAppStore((state) => state.dictationState)
  const partialTranscript = useAppStore((state) => state.partialTranscript)
  const dictationMeter = useDictationMeter()
  const isHoldMode = useAppStore((state) => state.settings?.voice?.dictationMode === 'hold')
  const shortcut = useShortcutKeyDetails('voice.dictation')

  const isVisible = ['listening', 'starting', 'stopping'].includes(dictationState)
  if (!isVisible) {
    return null
  }

  const isLoadingModel = dictationState === 'starting' && captureLive
  const isListening = dictationState === 'listening' || isLoadingModel
  const isClipping = isListening && dictationMeter.isClipping
  const isSpeaking = isListening && dictationMeter.isSpeaking && !isClipping
  const lifecycleLabel = isListening
    ? t('auto.components.dictation.DictationIndicator.3de5a129e7', 'Listening')
    : dictationState === 'starting'
      ? t('auto.components.dictation.DictationIndicator.7f3660a7ba', 'Starting mic…')
      : t('auto.components.dictation.DictationIndicator.f082d0cb9d', 'Processing…')
  const label = isClipping
    ? t('auto.components.dictation.DictationIndicator.4977162383', 'Too loud')
    : isSpeaking
      ? t('auto.components.dictation.DictationIndicator.25f2b7a6a5', 'Speaking')
      : lifecycleLabel
  const announcedLabel = isClipping ? label : lifecycleLabel
  const canStop = dictationState !== 'stopping'
  const showShortcut = !isHoldMode && shortcut.keys.length > 0
  const transcript = partialTranscript.trim()
  const stopLabel = t('auto.components.dictation.DictationIndicator.335e1bc6cb', 'Stop dictation')

  return (
    <div
      data-testid="dictation-indicator"
      className={cn(
        'fixed bottom-12 left-1/2 z-50 -translate-x-1/2 overflow-hidden',
        'border border-border bg-popover/95 text-sm text-popover-foreground shadow-floating backdrop-blur',
        'transition-[width,border-radius,opacity] duration-200 ease-out motion-reduce:transition-none',
        transcript
          ? 'w-[min(28rem,calc(100vw-2rem))] rounded-xl'
          : 'max-w-[min(28rem,calc(100vw-2rem))] rounded-full',
        isClipping && 'border-destructive/40 text-destructive'
      )}
    >
      <div className="flex h-10 items-center gap-2 px-2">
        <DictationGrapes
          level={dictationMeter.level}
          active={dictationState !== 'stopping'}
          transitioning={!isListening}
        />
        <span aria-hidden className="min-w-0 truncate font-medium">
          {label}
        </span>
        {isLoadingModel ? (
          <span aria-hidden className="min-w-0 truncate text-xs text-muted-foreground">
            {t(
              'auto.components.dictation.DictationIndicator.loadingModel',
              'Loading speech model…'
            )}
          </span>
        ) : null}
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcedLabel}
        </span>
        {canStop ? (
          <>
            <span aria-hidden className="ml-0.5 h-4 w-px shrink-0 bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stopLabel}
                  className="shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => dispatchDictationControl('stop')}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="flex items-center gap-1.5">
                {stopLabel}
                {showShortcut ? (
                  <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                ) : null}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </div>
      {transcript ? (
        <p className="truncate border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {transcript}
        </p>
      ) : null}
    </div>
  )
}
