import { useEffect } from 'react'
import { Loader2, Mic, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { truncateDictationTranscript } from './dictation-audio-meter'

const BAR_MULTIPLIERS = [0.35, 0.62, 0.9, 1, 0.82, 0.56, 0.4]
const NOTICE_TIMEOUT_MS = 3_000

export function DictationIndicator() {
  const dictationState = useAppStore((s) => s.dictationState)
  const partialTranscript = useAppStore((s) => s.partialTranscript)
  const dictationMeter = useAppStore((s) => s.dictationMeter)
  const dictationNotice = useAppStore((s) => s.dictationNotice)
  const clearDictationNotice = useAppStore((s) => s.clearDictationNotice)

  useEffect(() => {
    if (!dictationNotice) {
      return
    }

    const timeout = window.setTimeout(clearDictationNotice, NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [clearDictationNotice, dictationNotice])

  const isActive =
    dictationState === 'starting' || dictationState === 'listening' || dictationState === 'stopping'
  if (!isActive && !dictationNotice) {
    return null
  }

  const showNotice = !isActive && dictationNotice !== null
  const isListening = dictationState === 'listening'
  const isClipping = isListening && dictationMeter.isClipping
  const isSpeaking = isListening && dictationMeter.isSpeaking && !dictationMeter.isClipping
  const displayLevel = isListening
    ? dictationMeter.isSpeaking || dictationMeter.isClipping
      ? dictationMeter.level
      : Math.max(dictationMeter.level, 0.06)
    : 0
  const isIdleMeter = !isListening || (!dictationMeter.isSpeaking && !dictationMeter.isClipping)
  const label = (() => {
    if (showNotice) {
      return dictationNotice.message
    }
    if (dictationState === 'starting') {
      return 'Starting mic…'
    }
    if (dictationState === 'stopping') {
      return 'Processing…'
    }
    if (isClipping) {
      return 'Too loud'
    }
    if (isSpeaking) {
      return 'Speaking'
    }
    return 'Listening'
  })()
  const isTransitioning = dictationState === 'starting' || dictationState === 'stopping'
  const Icon = isTransitioning ? Loader2 : isClipping ? Volume2 : Mic
  const isDestructive = isClipping || (showNotice && dictationNotice.kind === 'error')
  const transcript = partialTranscript.trim()

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-12 left-1/2 z-50 -translate-x-1/2',
        'flex flex-col gap-1 px-3 py-2 text-sm',
        'border border-border/70 bg-popover/95 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] backdrop-blur',
        'transition-[width,transform,opacity] duration-200 ease-out motion-reduce:transition-none',
        transcript.length > 0
          ? 'w-[min(26rem,calc(100vw-2rem))] rounded-2xl'
          : 'max-w-[min(26rem,calc(100vw-2rem))] rounded-full',
        isDestructive && 'border-destructive/35 text-destructive'
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            isTransitioning && 'animate-spin motion-reduce:animate-none'
          )}
        />
        <span className="font-medium">{label}</span>
        <div className="ml-auto flex h-6 items-center gap-0.5" aria-hidden="true">
          {BAR_MULTIPLIERS.map((multiplier, index) => {
            const barHeight = Math.min(
              22,
              Math.max(4, Math.round(4 + displayLevel * multiplier * 18))
            )
            return (
              <span
                key={index}
                className={cn(
                  'w-1 rounded-full bg-current opacity-70 transition-[height,opacity] duration-75 motion-reduce:transition-none',
                  isIdleMeter && 'opacity-35'
                )}
                style={{ height: `${barHeight}px` }}
              />
            )
          })}
        </div>
      </div>
      {transcript.length > 0 &&
        (() => {
          const displayTranscript = truncateDictationTranscript(transcript)
          const hasLeadingEllipsis = displayTranscript.startsWith('…')
          return (
            <div className="flex items-baseline overflow-hidden border-t border-border/40 pt-1 text-sm text-muted-foreground">
              {hasLeadingEllipsis && <span className="shrink-0">…</span>}
              <div className="flex flex-1 justify-end overflow-hidden">
                <p className="shrink-0 whitespace-nowrap">
                  {hasLeadingEllipsis ? displayTranscript.slice(1) : displayTranscript}
                </p>
              </div>
            </div>
          )
        })()}
    </div>
  )
}
