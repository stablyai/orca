import { useLayoutEffect, useRef } from 'react'

const LOADING = 'loading'
const IDLE = 'idle'

/** A thin line along the bottom edge of the address bar while the page loads. */
export function BrowserLoadProgress({
  loading,
  failed
}: {
  loading: boolean
  failed: boolean
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)

  // Why imperative: the finish fade must read the trickle's last frame before its CSS animation is removed.
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) {
      return
    }
    const wasLoading = bar.dataset.browserLoadProgress === LOADING
    if (loading) {
      // A finish fade from the previous load gives way to the new trickle.
      bar.getAnimations().forEach((animation) => {
        if (!(animation instanceof CSSAnimation)) {
          animation.cancel()
        }
      })
      bar.dataset.browserLoadProgress = LOADING
      return
    }
    if (!wasLoading) {
      return
    }
    const { transform, opacity } = getComputedStyle(bar)
    // Still inside the show delay, or on a retained hidden page: nothing to fade.
    const showsFade =
      Number(opacity) > 0 &&
      document.visibilityState === 'visible' &&
      bar.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    bar.dataset.browserLoadProgress = IDLE
    if (!showsFade) {
      return
    }
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    // Why: a failed load fades where it stopped instead of filling up like a success.
    const end = failed || reducedMotion ? transform : 'scaleX(1)'
    bar.animate(
      [
        { transform, opacity },
        { transform: end, opacity, offset: 0.4 },
        { transform: end, opacity: 0 }
      ],
      { duration: 450, easing: 'ease-out' }
    )
  }, [failed, loading])

  useLayoutEffect(() => {
    const bar = barRef.current
    // Why: a script animation outlives its removed element and keeps ticking until cancelled.
    return () =>
      bar?.getAnimations().forEach((animation) => {
        if (!(animation instanceof CSSAnimation)) {
          animation.cancel()
        }
      })
  }, [])

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
    >
      <div
        ref={barRef}
        data-browser-load-progress={IDLE}
        className="browser-load-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-callout-note opacity-0"
      />
    </div>
  )
}
