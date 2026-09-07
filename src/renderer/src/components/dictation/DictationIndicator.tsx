import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Pause, Play, Square, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { isDictationSessionOpen } from '../../../../shared/speech-types'
import { dispatchDictationControl, type DictationControlAction } from './dictation-control-events'
import { DictationGrapes } from './DictationGrapes'
import { useDictationMeter } from './dictation-meter-store'

function DictationPillButton({
  action,
  label,
  shortcut,
  onClick,
  children
}: {
  action: DictationControlAction
  label: string
  shortcut?: ReactNode
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClick?.()
            dispatchDictationControl(action)
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="flex items-center gap-1.5">
        {label}
        {shortcut}
      </TooltipContent>
    </Tooltip>
  )
}

export function DictationIndicator() {
  const dictationState = useAppStore((state) => state.dictationState)
  const partialTranscript = useAppStore((state) => state.partialTranscript)
  const dictationMeter = useDictationMeter()
  const isHoldMode = useAppStore((state) => state.settings?.voice?.dictationMode === 'hold')
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const [clearedHint, setClearedHint] = useState(false)

  useEffect(() => {
    if (!clearedHint) {
      return
    }
    const timeout = window.setTimeout(() => setClearedHint(false), 1200)
    return () => window.clearTimeout(timeout)
  }, [clearedHint])

  useEffect(() => {
    if (partialTranscript.trim()) {
      setClearedHint(false)
    }
  }, [partialTranscript])

  if (!isDictationSessionOpen(dictationState)) {
    return null
  }

  const isListening = dictationState === 'listening'
  const isPaused = dictationState === 'paused'
  const isClipping = isListening && dictationMeter.isClipping && !clearedHint
  const isSpeaking = isListening && dictationMeter.isSpeaking && !isClipping && !clearedHint
  const clearedLabel = translate(
    'auto.components.dictation.DictationIndicator.c9db4ce67c',
    'Cleared'
  )
  const lifecycleLabel = clearedHint
    ? clearedLabel
    : dictationState === 'starting'
      ? translate('auto.components.dictation.DictationIndicator.7f3660a7ba', 'Starting mic…')
      : dictationState === 'stopping'
        ? translate('auto.components.dictation.DictationIndicator.f082d0cb9d', 'Processing…')
        : isPaused
          ? translate('auto.components.dictation.DictationIndicator.74cc85c4c7', 'Paused')
          : translate('auto.components.dictation.DictationIndicator.3de5a129e7', 'Listening')
  const label = isClipping
    ? translate('auto.components.dictation.DictationIndicator.4977162383', 'Too loud')
    : isSpeaking
      ? translate('auto.components.dictation.DictationIndicator.25f2b7a6a5', 'Speaking')
      : lifecycleLabel
  const announcedLabel = clearedHint ? clearedLabel : isClipping ? label : lifecycleLabel
  // Why: Pause/Clear must occupy layout from the first Starting frame. Gating
  // them on `listening` made the pill grow after STT became ready.
  const showSessionControls = dictationState !== 'stopping'
  const showShortcut = !isHoldMode && shortcut.keys.length > 0
  const transcript = partialTranscript.trim()
  const saveLabel = translate('auto.components.dictation.DictationIndicator.f37f083700', 'Save')
  const pauseLabel = translate('auto.components.dictation.DictationIndicator.88c56c1272', 'Pause')
  const resumeLabel = translate('auto.components.dictation.DictationIndicator.7cbca0dff5', 'Resume')
  const clearLabel = translate('auto.components.dictation.DictationIndicator.72676ac689', 'Clear')

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
          active={isListening}
          transitioning={dictationState === 'starting' || dictationState === 'stopping'}
        />
        <span aria-hidden className="min-w-0 truncate font-medium">
          {label}
        </span>
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcedLabel}
        </span>
        {showSessionControls ? (
          <>
            <span aria-hidden className="ml-auto h-4 w-px shrink-0 bg-border" />
            <DictationPillButton
              action={isPaused ? 'resume' : 'pause'}
              label={isPaused ? resumeLabel : pauseLabel}
            >
              {isPaused ? (
                <Play className="size-3 fill-current" />
              ) : (
                <Pause className="size-3 fill-current" />
              )}
            </DictationPillButton>
            <DictationPillButton
              action="stop"
              label={saveLabel}
              shortcut={
                showShortcut ? (
                  <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                ) : null
              }
            >
              <Square className="size-3 fill-current" />
            </DictationPillButton>
            <DictationPillButton
              action="clear"
              label={clearLabel}
              onClick={() => setClearedHint(true)}
            >
              <X className="size-3" />
            </DictationPillButton>
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
