import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

type ToastFeedItem = {
  readonly id: string
  readonly task: string
  readonly verdict: string
  readonly body: string
}

const TOAST_FEED: readonly ToastFeedItem[] = [
  {
    id: 'redesign-auth-flow',
    task: 'redesign-auth-flow',
    verdict: 'Claude finished',
    body: 'Refactored auth middleware. Ready for review.'
  },
  {
    id: 'migrate-users-sql',
    task: 'migrate-users-sql',
    verdict: 'Codex finished',
    body: 'Migration written. Tests pass on a fresh DB.'
  },
  {
    id: 'audit-api-error-logs',
    task: 'audit-api-error-logs',
    verdict: 'OpenCode finished',
    body: 'Scanned 24h of errors. Top offender: /v1/sessions.'
  }
]

// Match the workspaces tile cadence (~3.6s per beat). Each toast holds in the
// stack for HOLD_MS and a fresh one drops in every INTERVAL_MS.
const TOAST_INTERVAL_MS = 3600
const TOAST_HOLD_MS = 5200
// Cap stacked toasts so the column never grows past the visible stage.
const TOAST_MAX_STACK = 2
const TOAST_INITIAL_DELAY_MS = 500
const TOAST_TRANSITION_MS = 420

type ActiveToast = {
  readonly key: number
  readonly item: ToastFeedItem
  readonly phase: 'in' | 'out'
}

// Why: kept for later use even though Notifications is no longer a tour substep.
export function NotificationsPage(props: { active: boolean }): JSX.Element {
  const { active } = props
  const [toasts, setToasts] = useState<readonly ActiveToast[]>([])
  const cycleRef = useRef(0)
  const keyRef = useRef(0)

  useEffect(() => {
    if (!active) {
      setToasts([])
      cycleRef.current = 0
      return
    }
    const timeouts: number[] = []
    const at = (delay: number, fn: () => void): void => {
      timeouts.push(window.setTimeout(fn, delay))
    }

    const pushToast = (): void => {
      const item = TOAST_FEED[cycleRef.current % TOAST_FEED.length]
      cycleRef.current += 1
      keyRef.current += 1
      const key = keyRef.current
      setToasts((prev) => {
        // Mark anything past the cap as exiting so the stack never overflows.
        const overflow = prev.slice(TOAST_MAX_STACK - 1)
        const kept = prev.slice(0, TOAST_MAX_STACK - 1)
        return [
          { key, item, phase: 'in' as const },
          ...kept,
          ...overflow.map((t) => ({ ...t, phase: 'out' as const }))
        ]
      })
      // After holding in the stack for a beat, flip this toast to 'out' so it
      // slides off-screen, then drop it from the DOM.
      at(TOAST_HOLD_MS, () => {
        setToasts((prev) => prev.map((t) => (t.key === key ? { ...t, phase: 'out' } : t)))
        at(TOAST_TRANSITION_MS, () => {
          setToasts((prev) => prev.filter((t) => t.key !== key))
        })
      })
      // Drop overflow toasts (already flipped to 'out' above) once their exit
      // transition completes.
      at(TOAST_TRANSITION_MS, () => {
        setToasts((prev) => prev.filter((t) => t.phase === 'in' || t.key === key))
      })
    }

    at(TOAST_INITIAL_DELAY_MS, pushToast)
    const interval = window.setInterval(pushToast, TOAST_INTERVAL_MS)
    return () => {
      window.clearInterval(interval)
      timeouts.forEach((id) => window.clearTimeout(id))
      setToasts([])
      cycleRef.current = 0
    }
  }, [active])

  return (
    <div className="relative h-full w-full">
      {/* Stage clips toasts that overshoot so the slide reads as "from
          off-screen", reserving the bottom 56px for the CTA card. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bottom-14 overflow-hidden">
        <div className="absolute right-4 top-4 flex w-[392px] flex-col gap-2.5">
          {toasts.map((t) => (
            <ToastCard key={t.key} item={t.item} phase={t.phase} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ToastCard(props: { item: ToastFeedItem; phase: ActiveToast['phase'] }): JSX.Element {
  const { item, phase } = props
  const ref = useRef<HTMLDivElement | null>(null)

  // Why: imperatively pin the toast off-screen on first paint with no
  // transition, force a reflow, then enable transition + slide to 0. This
  // avoids React-18 batching folding the off-screen frame into the on-screen
  // one and skipping the slide. Same pattern is used for the exit phase: we
  // detect the phase flip and animate to translateX(120%).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    if (phase === 'in') {
      // Start off-screen with no transition.
      el.style.transition = 'none'
      el.style.transform = 'translateX(120%)'
      el.style.opacity = '0'
      // Force layout so the browser commits the off-screen frame before we
      // re-enable the transition.
      void el.offsetWidth
      el.style.transition = `transform ${TOAST_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${TOAST_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
      el.style.transform = 'translateX(0)'
      el.style.opacity = '1'
    } else {
      el.style.transition = `transform ${TOAST_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.6, 1), opacity ${TOAST_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.6, 1)`
      el.style.transform = 'translateX(120%)'
      el.style.opacity = '0'
    }
  }, [phase])

  return (
    <div
      ref={ref}
      className="pointer-events-auto grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3 rounded-[14px] border border-foreground/[0.06] px-3.5 pb-[13px] pt-3 backdrop-blur-md shadow-[0_18px_40px_rgba(0,0,0,0.22),0_4px_10px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.6)]"
      style={{
        background: 'rgba(245,245,245,0.92)',
        // Initial inline values so the first paint is off-screen even before
        // the layout effect runs (prevents a one-frame flash at translateX(0)).
        transform: 'translateX(120%)',
        opacity: 0
      }}
    >
      <span
        className="inline-flex size-9 items-center justify-center rounded-lg text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_1px_2px_rgba(0,0,0,0.25)]"
        style={{ background: 'linear-gradient(180deg, #2a2a2d 0%, #0e0e10 100%)' }}
      >
        <OrcaGlyph />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline whitespace-nowrap text-[13px] leading-[1.25] text-foreground">
          <span className="font-bold">orca</span>
          <span className="px-1 text-muted-foreground">/</span>
          <span>{item.task}</span>
          <span className="px-1.5 text-muted-foreground">-</span>
          <span className="font-medium">{item.verdict}</span>
        </div>
        <div
          className="mt-[3px] overflow-hidden text-[12.5px] leading-[1.35] text-foreground"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical'
          }}
        >
          {item.body}
        </div>
      </div>
    </div>
  )
}

function OrcaGlyph(): JSX.Element {
  return (
    <svg width={22} height={22} viewBox="0 0 318.60232 202.66667" aria-hidden focusable="false">
      <g transform="translate(-6.6666669,-70.666669)">
        <path
          fill="currentColor"
          d="m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z"
        />
      </g>
    </svg>
  )
}
