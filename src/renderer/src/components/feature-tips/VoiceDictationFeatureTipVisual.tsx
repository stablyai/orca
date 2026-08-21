import { useEffect, useState, type JSX } from 'react'
import { Mic, Square } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

const TYPE_START_DELAY_MS = 650
const TYPE_INTERVAL_MS = 36
const WAVEFORM_BAR_HEIGHTS = [38, 70, 100, 58, 82]

export function VoiceDictationFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const dictatedPrompt = translate(
    'featureTips.voice.demoPrompt',
    'Review this diff for edge cases and add tests for anything you find.'
  )
  const [typedLength, setTypedLength] = useState(0)
  const effectiveTypedLength = reducedMotion ? dictatedPrompt.length : typedLength
  const typing = !reducedMotion && effectiveTypedLength < dictatedPrompt.length

  useEffect(() => {
    if (reducedMotion) {
      return
    }

    let cancelled = false
    let timeoutId: number | undefined
    let nextLength = 0
    const typeNext = (): void => {
      if (cancelled) {
        return
      }
      nextLength += 1
      setTypedLength(nextLength)
      if (nextLength < dictatedPrompt.length) {
        timeoutId = window.setTimeout(typeNext, TYPE_INTERVAL_MS)
      }
    }

    timeoutId = window.setTimeout(typeNext, TYPE_START_DELAY_MS)
    return () => {
      cancelled = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [dictatedPrompt, reducedMotion])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      {shortcut.keys.length > 0 ? (
        <div className="flex items-center gap-2.5">
          <ShortcutKeyCombo
            keys={shortcut.keys}
            doubleTap={shortcut.doubleTap}
            keyCapClassName="h-7 min-w-7 bg-foreground/[0.08] px-2 font-semibold shadow-xs"
          />
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('featureTips.voice.startDictation', 'Start dictation')}
          </span>
        </div>
      ) : null}

      <div className="relative mt-4 h-56 w-full max-w-[21rem] overflow-hidden rounded-xl border border-border/80 bg-card text-left shadow-xs">
        <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-[11px] text-muted-foreground">
          <span className="size-2 rounded-full bg-foreground/35" />
          <span>{translate('featureTips.voice.agentPromptTitle', 'Agent prompt')}</span>
        </div>

        <div className="absolute inset-x-0 bottom-0 top-10 bg-[var(--editor-surface)] px-4 py-5 font-mono text-xs leading-relaxed">
          <div className="flex min-w-0 gap-2.5">
            <span className="shrink-0 text-muted-foreground">›</span>
            <span
              data-testid="dictated-prompt"
              className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground"
            >
              {dictatedPrompt.slice(0, effectiveTypedLength)}
              {typing ? (
                <span className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-foreground/75" />
              ) : null}
            </span>
          </div>
        </div>

        <div className="absolute inset-x-3 bottom-3 flex h-10 items-center gap-2 rounded-lg bg-foreground/90 px-3 text-xs font-medium text-background shadow-lg">
          <Mic className="size-4 shrink-0" />
          <span className="flex h-4 items-center gap-0.5" aria-hidden="true">
            {WAVEFORM_BAR_HEIGHTS.map((height, index) => (
              <span
                key={height}
                className={`block w-0.5 rounded-full bg-current ${typing ? 'animate-waveform' : ''}`}
                style={{ height: `${height}%`, animationDelay: `${index * 0.1}s` }}
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {translate('featureTips.voice.listening', 'Listening...')}
          </span>
          <Square className="size-2.5 shrink-0 fill-current opacity-55" />
        </div>
      </div>
    </div>
  )
}
