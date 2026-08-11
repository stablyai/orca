import { useAppStore } from '@/store'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { dispatchDictationControl } from './dictation-control-events'

export function DictationIndicator() {
  const dictationState = useAppStore((s) => s.dictationState)
  const partialTranscript = useAppStore((s) => s.partialTranscript)
  const isHoldMode = useAppStore((s) => s.settings?.voice?.dictationMode === 'hold')
  const shortcut = useShortcutKeyDetails('voice.dictation')

  if (
    dictationState !== 'listening' &&
    dictationState !== 'starting' &&
    dictationState !== 'stopping'
  ) {
    return null
  }

  const label =
    dictationState === 'starting'
      ? 'Starting...'
      : dictationState === 'stopping'
        ? 'Processing...'
        : partialTranscript || 'Listening...'

  // Why: the stop path is a no-op once the session is already tearing down.
  const canStop = dictationState !== 'stopping'
  // Hold mode stops on key release, so a "press ⌘E" chip would misstate the binding.
  const showShortcut = !isHoldMode && shortcut.keys.length > 0
  const stopLabel = translate(
    'auto.components.dictation.DictationIndicator.335e1bc6cb',
    'Stop dictation'
  )

  return (
    <div className="fixed bottom-12 left-1/2 z-50 flex max-w-[min(36rem,calc(100vw-3rem))] -translate-x-1/2 items-center gap-2 rounded-lg bg-foreground/90 px-3 py-1.5 text-background text-sm shadow-lg">
      <Mic className={`size-4 shrink-0 ${dictationState === 'listening' ? 'animate-pulse' : ''}`} />
      <span className="min-w-0 truncate">{label}</span>
      {canStop ? (
        <>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-background/25" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={stopLabel}
                className="shrink-0 text-background/55 hover:bg-background/15 hover:text-background/85"
                // Why: dictation inserts into the element focused when it started;
                // taking focus on click would drop the final transcript.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => dispatchDictationControl('stop')}
              >
                <Square className="size-3 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="flex items-center gap-1.5">
              {stopLabel}
              {showShortcut ? (
                <ShortcutKeyCombo
                  keys={shortcut.keys}
                  doubleTap={shortcut.doubleTap}
                  className="gap-0.5"
                  keyCapClassName="min-w-0 border-background/20 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
                  separatorClassName="text-[10px] text-background/70"
                />
              ) : null}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  )
}
