import { useEffect, useRef, useState } from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { ArrowUp, Check, CornerDownLeft, Loader2 } from 'lucide-react'
import { isDictationPillShown } from '../../../../shared/dictation-session-machine'
import { dictationSeparators } from '../../../../shared/dictation-transcript-spacing'
import { CLOUD_DICTATION_MAX_SECONDS } from '../../../../shared/rpc-contract/speech-params'
import { dispatchDictationControl } from './dictation-control-events'
import { DictationGrapes } from './DictationGrapes'
import { useDictationMeter } from './dictation-meter-store'
import type { DictationPillAnchor } from './dictation-pill-anchor'
import { DictationPillCloseButton, DictationPillFailure } from './DictationPillFailure'
import { DictationPillShell } from './DictationPillShell'
import { DictationSetupPill } from './DictationSetupPill'
import { loadSpeechCatalog } from './speech-model-update-check'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'
import type { DictationFailureKind } from './dictation-toasts'
import type { DictationQueuedSendKind } from './use-dictation-queued-send'
import type { DictationCleanupNotice } from './use-dictation-cleanup'
import { DictationCleanupNoticePill } from './DictationCleanupNoticePill'

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
  cleanup: {
    /** AI cleanup is running on the finished dictation's words. */
    cleaning: boolean
    notice: DictationCleanupNotice | null
    dismissNotice: () => void
  }
}

type DictationSetupProps = {
  /** Set while the pill offers the download the selected model needs instead of recording. */
  setup: SpeechModelUpdateTarget | null
  onSetupClose: () => void
}

export function DictationIndicator({
  setup,
  onSetupClose,
  ...props
}: DictationIndicatorProps & DictationSetupProps) {
  const dictationState = useAppStore((state) => state.dictationState)
  if (isDictationPillShown(dictationState)) {
    return <DictationPill {...props} />
  }
  if (setup) {
    return <DictationSetupPill target={setup} anchor={props.anchor} onClose={onSetupClose} />
  }
  const { notice, dismissNotice } = props.cleanup
  return notice ? <DictationCleanupNoticePill notice={notice} onClose={dismissNotice} /> : null
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

// The paired web client has no catalog; its host caps itself.
function useIsCloudModel(): boolean {
  const modelId = useAppStore((state) => state.settings?.voice?.sttModel)
  const [cloud, setCloud] = useState(false)
  useEffect(() => {
    let current = true
    void loadSpeechCatalog().then((catalog) => {
      if (current) {
        setCloud(catalog.some((model) => model.id === modelId && model.provider !== 'local'))
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

// Words heard but not committed yet: they land at the next pause.
function DictationPendingDots() {
  return (
    <span className="ml-1.5 inline-flex gap-1 align-middle">
      {[0, 150, 300].map((delayMs) => (
        <span
          key={delayMs}
          className="size-1 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
          style={{ animationDelay: `${delayMs}ms` }}
        />
      ))}
    </span>
  )
}

function DictationPill({ captureLive, anchor, failure, queued, cleanup }: DictationIndicatorProps) {
  const t = useTranslate()
  const dictationState = useAppStore((state) => state.dictationState)
  const liveText = useAppStore((state) => state.liveText)
  const isHoldMode = useAppStore((state) => state.settings?.voice?.dictationMode === 'hold')
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const cloudModel = useIsCloudModel()

  const finishing = dictationState === 'stopping'
  const recording = dictationState === 'listening' || (dictationState === 'starting' && captureLive)
  // Counts recorded time, so it waits for the mic to open.
  const seconds = useElapsedSeconds(recording)
  const showSpinner = useDelayedFlag(finishing, FINISH_SPINNER_DELAY_MS)
  const nearCloudLimit = cloudModel && seconds >= CLOUD_LIMIT_WARNING_SECONDS
  const failedKind = dictationState === 'error' ? failure : null
  const { committed, speechPending } = liveText
  const tentative = liveText.tentative.trim()
  const { cleaning } = cleanup
  // While cleaning up, the pill says so; the queued send shows again once the text lands.
  const queuedStatus = cleaning
    ? null
    : queued === 'chat'
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
  const status = cleaning
    ? t('components.dictation.DictationIndicator.cleaningUp', 'Cleaning up…')
    : finishing
      ? t('auto.components.dictation.DictationIndicator.finishing', 'Finishing…')
      : t('auto.components.dictation.DictationIndicator.listening', 'Listening…')
  const announced = nearCloudLimit
    ? `${status} ${t('auto.components.dictation.DictationIndicator.oneMinuteLeft', 'One minute left.')}`
    : (queuedStatus ?? status)
  const cancelLabel = cleaning
    ? t('components.dictation.DictationIndicator.skipCleanup', 'Skip cleanup and insert as heard')
    : t('auto.components.dictation.DictationIndicator.cancel', 'Cancel')
  const finishLabel = t('auto.components.dictation.DictationIndicator.finish', 'Finish')

  return (
    <DictationPillShell
      anchor={anchor}
      testId="dictation-indicator"
      className={cn(failedKind && 'border-destructive/40')}
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
          ) : !cleaning && (committed || tentative || speechPending) ? (
            // Right-aligned so the newest words stay in view; older ones fade off the left edge.
            <span
              aria-hidden
              className="flex h-6 min-w-0 flex-1 items-center justify-end overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,transparent,black_24px)]"
            >
              <span className="shrink-0">
                {committed}
                {dictationSeparators(committed, tentative, '').leading}
                <span className="text-muted-foreground">{tentative}</span>
                {speechPending ? <DictationPendingDots /> : null}
              </span>
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
    </DictationPillShell>
  )
}
