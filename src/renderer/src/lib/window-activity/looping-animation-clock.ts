import { rideSharedNow } from '@/lib/window-activity/use-now'

// Why: a running CSS animation makes the compositor tick every display refresh, even one that
// moves once a second, and each changed frame redraws the whole window. So spinners and pulses
// never run and never get a timer: they sit paused, and this clock steps them only inside a frame
// the app is drawing anyway, when an elapsed-time label repaints. A loop then costs no frame at all.
// Steps per cycle, by keyframes name: an eighth of a turn reads as rotation; a pulse breathes over four.
const STEPS_PER_CYCLE: ReadonlyMap<string, number> = new Map([
  ['spin', 8],
  ['agent-spinner-rotate', 8],
  ['pulse', 4],
  ['browser-agent-glow-breathe', 4],
  // The stale-review highlight crosses its text in six hops.
  ['tw-shimmer', 6]
])
const LABEL_TICK_MS = 1_000
// Bounds the hit tests in a tick where a lot of off-screen content changed.
const MUTATIONS_TO_CHECK = 64

// The slice of a CSS animation the clock touches; a DOM Animation satisfies it as is.
type LoopingAnimation = {
  readonly animationName?: string
  readonly playState: AnimationPlayState
  currentTime: CSSNumberish | null
  pause: () => void
  readonly effect: { getComputedTiming: () => { duration?: unknown } } | null
}

export type LoopingAnimationClockDeps = {
  getAnimations: () => readonly LoopingAnimation[]
  /** A spinner or pulse began on an element: it mounted, so its frame is being drawn anyway. */
  onLoopStart: (listener: (started: readonly LoopingAnimation[]) => void) => () => void
  /** A second tick in which something else on screen repainted. */
  onLabelRepaint: (listener: () => void) => () => void
}

// Whether the pixels of this node are showing: not clipped by a scroller, not scrolled out of the window.
function isOnScreen(doc: Document, node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement
  if (!element) {
    return false
  }
  const rect = element.getBoundingClientRect()
  const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit !== null && element.contains(hit)
}

function documentDeps(doc: Document): LoopingAnimationClockDeps {
  return {
    getAnimations: () => doc.getAnimations(),
    onLoopStart: (listener) => {
      const onStart = (event: AnimationEvent): void => {
        if (STEPS_PER_CYCLE.has(event.animationName) && event.target instanceof Element) {
          // Only this element's animations: a document-wide scan per mount would not scale.
          // subtree: an animation on ::before belongs to this element too.
          listener(event.target.getAnimations({ subtree: true }))
        }
      }
      doc.addEventListener('animationstart', onStart)
      return () => doc.removeEventListener('animationstart', onStart)
    },
    onLabelRepaint: (listener) => {
      if (typeof MutationObserver !== 'function') {
        return () => {}
      }
      // Armed only across a tick's own microtasks, so the rest of the app's DOM work goes unobserved.
      let seen: MutationRecord[] = []
      const mutations = new MutationObserver((records) => {
        seen.push(...records)
      })
      const stopRiding = rideSharedNow(LABEL_TICK_MS, () => {
        mutations.observe(doc.body, { subtree: true, childList: true, characterData: true })
        // Two hops: React flushes the labels' update in a microtask queued before this one.
        queueMicrotask(() =>
          queueMicrotask(() => {
            const records = [...seen, ...mutations.takeRecords()].slice(0, MUTATIONS_TO_CHECK)
            seen = []
            mutations.disconnect()
            if (records.some((record) => isOnScreen(doc, record.target))) {
              listener()
            }
          })
        )
      })
      return () => {
        stopRiding()
        mutations.disconnect()
      }
    }
  }
}

/** Steps every spinner and pulse in the document inside frames the app already draws; never causes one. */
export function installLoopingAnimationClock(
  deps: LoopingAnimationClockDeps = documentDeps(document)
): () => void {
  let step = 0

  const apply = (animations: readonly LoopingAnimation[]): void => {
    for (const animation of animations) {
      const steps =
        animation.animationName === undefined
          ? undefined
          : STEPS_PER_CYCLE.get(animation.animationName)
      if (steps === undefined) {
        continue
      }
      if (animation.playState === 'running') {
        animation.pause()
      }
      const duration = Number(animation.effect?.getComputedTiming().duration)
      if (Number.isFinite(duration)) {
        animation.currentTime = ((step % steps) / steps) * duration
      }
    }
  }

  const stopRepaints = deps.onLabelRepaint(() => {
    step++
    // CSS is the registry: whatever currently carries one of these animations gets stepped.
    apply(deps.getAnimations())
  })
  // A new loop joins the shared step before its first paint.
  const stopStarts = deps.onLoopStart(apply)

  return () => {
    stopRepaints()
    stopStarts()
  }
}
