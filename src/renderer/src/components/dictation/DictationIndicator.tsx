import { useEffect, useRef, useState } from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { KEEPS_FOCUS_ATTRIBUTE } from '@/lib/focus-keeping-press'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { ArrowUp, Check, CornerDownLeft, Loader2 } from 'lucide-react'
import { isDictationPillShown } from '../../../../shared/dictation-session-machine'
import { CLOUD_DICTATION_MAX_SECONDS } from '../../../../shared/rpc-contract/speech-params'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { dispatchDictationControl } from './dictation-control-events'
import { DictationGrapes } from './DictationGrapes'
import { useDictationMeter } from './dictation-meter-store'
import { useDictationPillBox, type DictationPillAnchor } from './dictation-pill-anchor'
import { DictationPillCloseButton, DictationPillFailure } from './DictationPillFailure'
import type { DictationFailureKind } from './dictation-toasts'
import type { DictationQueuedSendKind } from './use-dictation-queued-send'

// The finish button turns into a spinner only when finishing is slow enough to notice.
const FINISH_SPINNER_DELAY_MS = 200
// The timer warns a minute before cloud dictation stops.
const CLOUD_LIMIT_WARNING_SECONDS = CLOUD_DICTATION_MAX_SECONDS - 60

type DictationIndicatorProps = {
  /** The mic is recording (and buffering) while the speech engine is still starting. */
  captureLive: boolean
  anchor: DictationPillAnchor | null
  /** Set while the error pill shows a failed recording that can be retried. */
  failure: DictationFailureKind | null
  /** A send waiting for this dictation's words to land. */
  queued: DictationQueuedSendKind | null
}

export function DictationIndicator(props: DictationIndicatorProps) {
  const dictationState = useAppStore((state) => state.dictationState)
  return isDictationPillShown(dictationState) ? <DictationPill {...props} /> : null
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Seconds since `running` first turned on; holds still once it turns off. */
function useElapsedSeconds(running: boolean): number {
  const startedAtRef = useRef<number | null>(null)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) {
      return
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = performance.now()
    }
    const startedAt = startedAtRef.current
    // Measured from the start, so ticks skipped while the window is hidden don't drift it.
    return installWindowVisibilityInterval({
      run: () => setSeconds(Math.floor((performance.now() - startedAt) / 1000)),
      intervalMs: 250
    })
  }, [running])
  return seconds
}

// The catalog never changes while the app runs; the paired web client has none and its host caps itself.
let catalogRequest: Promise<SpeechModelManifest[]> | null = null

function useIsCloudModel(): boolean {
  const modelId = useAppStore((state) => state.settings?.voice?.sttModel)
  const [cloud, setCloud] = useState(false)
  useEffect(() => {
    let current = true
    if (!catalogRequest) {
      catalogRequest = Promise.resolve()
        .then(() => window.api.speech.getCatalog())
        .catch(() => [])
    }
    void catalogRequest.then((catalog) => {
      if (current) {
        setCloud(catalog.some((model) => model.id === modelId && model.provider === 'openai'))
      }
    })
    return () => {
      current = false
    }
  }, [modelId])
  return cloud
}

function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false)
  useEffect(() => {
    if (!on) {
      setDelayed(false)
      return
    }
    const id = window.setTimeout(() => setDelayed(true), delayMs)
    return () => window.clearTimeout(id)
  }, [on, delayMs])
  return delayed
}

// Only this re-renders per meter tick, not the whole pill.
function DictationPillMeter({ recording, status }: { recording: boolean; status: string }) {
  const t = useTranslate()
  const meter = useDictationMeter()
  const clipping = recording && meter.isClipping
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {clipping
          ? t('auto.components.dictation.DictationIndicator.4977162383', 'Too loud')
          : status}
      </span>
      <DictationGrapes
        level={meter.level}
        active={recording}
        className={cn(clipping && 'text-destructive')}
      />
    </>
  )
}

// Presses on the pill keep focus where the words are going.
const keepFocus = (event: React.MouseEvent): void => event.preventDefault()
const keepFocusProps = { [KEEPS_FOCUS_ATTRIBUTE]: '', onMouseDown: keepFocus }

function DictationPill({ captureLive, anchor, failure, queued }: DictationIndicatorProps) {
  const t = useTranslate()
  const dictationState = useAppStore((state) => state.dictationState)
  const partialTranscript = useAppStore((state) => state.partialTranscript)
  const isHoldMode = useAppStore((state) => state.settings?.voice?.dictationMode === 'hold')
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const box = useDictationPillBox(anchor)
  const cloudModel = useIsCloudModel()

  const finishing = dictationState === 'stopping'
  const recording = dictationState === 'listening' || (dictationState === 'starting' && captureLive)
  // Counts recorded time, so it waits for the mic to open.
  const seconds = useElapsedSeconds(recording)
  const showSpinner = useDelayedFlag(finishing, FINISH_SPINNER_DELAY_MS)
  const nearCloudLimit = cloudModel && seconds >= CLOUD_LIMIT_WARNING_SECONDS
  const failedKind = dictationState === 'error' ? failure : null
  const transcript = partialTranscript.trim()
  const queuedStatus =
    queued === 'chat'
      ? t(
          'auto.components.dictation.DictationIndicator.sendsWhenLanded',
          'Sends when the text lands'
        )
      : queued === 'terminal'
        ? t(
            'auto.components.dictation.DictationIndicator.entersWhenLanded',
            'Presses Enter when the text lands'
          )
        : null
  const status = finishing
    ? t('auto.components.dictation.DictationIndicator.finishing', 'Finishing…')
    : t('auto.components.dictation.DictationIndicator.listening', 'Listening…')
  const announced = nearCloudLimit
    ? `${status} ${t('auto.components.dictation.DictationIndicator.oneMinuteLeft', 'One minute left.')}`
    : (queuedStatus ?? status)
  const cancelLabel = t('auto.components.dictation.DictationIndicator.cancel', 'Cancel')
  const finishLabel = t('auto.components.dictation.DictationIndicator.finish', 'Finish')

  return (
    <div
      data-testid="dictation-indicator"
      className={cn(
        'fixed z-50 flex h-10 -translate-x-1/2 items-center gap-2 rounded-full px-2 text-[13px]',
        'border border-border bg-popover/95 text-popover-foreground shadow-floating backdrop-blur',
        'transition-[opacity,translate] duration-180 ease-out starting:translate-y-1.5 starting:opacity-0 motion-reduce:transition-opacity',
        !box && 'bottom-12 left-1/2 w-[min(440px,calc(100vw-2rem))]',
        failedKind && 'border-destructive/40'
      )}
      style={box ? { left: box.left, bottom: box.bottom, width: box.width } : undefined}
      {...keepFocusProps}
    >
      {failedKind ? (
        <DictationPillFailure kind={failedKind} />
      ) : (
        <>
          <DictationPillCloseButton label={cancelLabel} />
          <DictationPillMeter recording={recording} status={announced} />
          {queuedStatus ? (
            <span
              aria-hidden
              className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground"
            >
              {queued === 'chat' ? (
                <ArrowUp className="size-3.5 shrink-0" />
              ) : (
                <CornerDownLeft className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{queuedStatus}</span>
            </span>
          ) : transcript ? (
            <span
              aria-hidden
              className="flex h-6 min-w-0 flex-1 items-center justify-end overflow-hidden whitespace-nowrap text-muted-foreground [mask-image:linear-gradient(to_right,transparent,black_24px)]"
            >
              <span className="shrink-0">{transcript}</span>
            </span>
          ) : (
            <span aria-hidden className="min-w-0 flex-1 truncate text-muted-foreground">
              {status}
            </span>
          )}
          <span
            aria-hidden
            className={cn(
              'w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground',
              nearCloudLimit && 'text-status-warning'
            )}
          >
            {formatElapsed(seconds)}
          </span>
          {finishing ? (
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground"
            >
              {showSpinner ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" strokeWidth={2.5} />
              )}
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs-round"
                  aria-label={finishLabel}
                  onClick={() => dispatchDictationControl('stop')}
                >
                  <Check className="size-3.5" strokeWidth={2.5} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                <span className="flex items-center gap-1.5">
                  {finishLabel}
                  {!isHoldMode && shortcut.keys.length > 0 ? (
                    <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                  ) : null}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  )
}
