// The progress card in the bottom-right notification stack: the app update's card, shared by other
// long background work ("Move to this computer"). Minimize (−) folds it into a status-bar segment;
// clicking the segment brings it back. Escape minimizes. It never takes focus by itself.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { useTranslate } from '@/i18n/use-translate'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'

const EXIT_MS = 150

export function progressCardAnimationClass(
  prefersReducedMotion: boolean,
  exiting: boolean
): string {
  if (prefersReducedMotion) {
    return ''
  }
  return exiting ? 'animate-update-card-exit' : 'animate-update-card-enter'
}

/** Runs `then` after the card's exit animation (at once with reduced motion). */
export function useProgressCardExit(): {
  exiting: boolean
  animationClass: string
  exit: (then: () => void) => void
} {
  const prefersReducedMotion = usePrefersReducedMotion()
  const [exiting, setExiting] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
      }
    },
    []
  )
  const exit = useCallback(
    (then: () => void) => {
      if (prefersReducedMotion) {
        then()
        return
      }
      setExiting(true)
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
      }
      timer.current = window.setTimeout(() => {
        timer.current = null
        setExiting(false)
        then()
      }, EXIT_MS)
    },
    [prefersReducedMotion]
  )
  return {
    exiting,
    animationClass: progressCardAnimationClass(prefersReducedMotion, exiting),
    exit
  }
}

export function ProgressCard({
  ariaLabel,
  animationClass,
  onEscape,
  children
}: {
  ariaLabel: string
  animationClass: string
  /** Escape: minimize while work runs, dismiss once it settled. */
  onEscape: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // The animation sits on a wrapper so the Card keeps static classes.
  return (
    <div className={animationClass}>
      <Card
        role="complementary"
        aria-label={ariaLabel}
        aria-live="polite"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onEscape()
          }
        }}
        size="flush"
      >
        {children}
      </Card>
    </div>
  )
}

/** Title with the card's one corner control: − (minimize to status bar) or × (dismiss). */
export function ProgressCardHeader({
  title,
  onMinimize,
  onDismiss,
  dismissLabel
}: {
  title: React.ReactNode
  onMinimize?: () => void
  onDismiss?: () => void
  dismissLabel?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-start justify-between gap-2">
      <h3 className="min-w-0 text-sm font-semibold">{title}</h3>
      {onMinimize ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onMinimize}
          aria-label={t('auto.components.UpdateCard.8acbdd3961', 'Minimize to status bar')}
        >
          <Minus className="size-3.5" />
        </Button>
      ) : onDismiss ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onDismiss}
          aria-label={dismissLabel ?? t('progressCard.dismiss', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
