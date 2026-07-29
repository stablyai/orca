// Why: a per-element infinite CSS animation keeps Chromium's frame pipeline
// awake the whole time any agent spinner is visible (~23.5ms CPU/s measured
// live, nearly independent of cadence, scaling per element). Background
// throttling only helps hidden windows — a visible sidebar full of working
// agents pays continuously. One shared low-rate clock steps every registered
// spinner element's transform directly, so the renderer idles between ticks
// and costs the same whether one agent or fifty are working.
import { isWindowVisible } from './window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

const SPIN_STEP_DEGREES = 30
const SPIN_STEPS = 360 / SPIN_STEP_DEGREES
// Why: 12 steps/s at 30° matches the retired CSS animation exactly — slower
// cadences read as sluggish next to it. The win over CSS is structural (idle
// between ticks, one timer for N spinners), not the tick rate.
export const AGENT_SPINNER_TICK_MS = 1000 / 12

const elements = new Set<HTMLElement>()
let timer: ReturnType<typeof setInterval> | null = null
let step = 0
let teardownGlobalListeners: (() => void) | null = null

function currentTransform(): string {
  return `rotate(${step * SPIN_STEP_DEGREES}deg)`
}

function tick(): void {
  step = (step + 1) % SPIN_STEPS
  const transform = currentTransform()
  for (const el of elements) {
    el.style.transform = transform
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function shouldRun(): boolean {
  // Why: the stale-visibility latch proves user input arrived while the macOS
  // occlusion tracker still claims hidden — keep spinning for the user we know
  // is watching instead of freezing until the tracker recovers.
  const visible = isWindowVisible() || isDocumentVisibilityProvenStale()
  return elements.size > 0 && visible && !prefersReducedMotion()
}

function reconcile(): void {
  if (shouldRun()) {
    if (timer === null) {
      // Advance immediately so a just-restored window visibly resumes.
      tick()
      timer = setInterval(tick, AGENT_SPINNER_TICK_MS)
    }
    return
  }
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function installGlobalListeners(): void {
  if (
    teardownGlobalListeners !== null ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return
  }
  const onSignal = (): void => {
    reconcile()
  }
  document.addEventListener('visibilitychange', onSignal)
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  reducedMotionQuery?.addEventListener?.('change', onSignal)
  const unregisterStaleRecovery = registerStaleDocumentVisibilityRecovery(onSignal)
  teardownGlobalListeners = () => {
    document.removeEventListener('visibilitychange', onSignal)
    reducedMotionQuery?.removeEventListener?.('change', onSignal)
    unregisterStaleRecovery()
  }
}

export function registerAgentSpinnerElement(el: HTMLElement): () => void {
  elements.add(el)
  // Join in phase with the shared dial so late-mounting spinners stay in sync.
  el.style.transform = currentTransform()
  installGlobalListeners()
  reconcile()
  return () => {
    elements.delete(el)
    reconcile()
    if (elements.size === 0 && teardownGlobalListeners !== null) {
      teardownGlobalListeners()
      teardownGlobalListeners = null
    }
  }
}

/** Stable React ref callback: attach to a spinner element to spin it. */
export function agentSpinnerRef(el: HTMLElement | null): (() => void) | undefined {
  if (el === null) {
    return undefined
  }
  return registerAgentSpinnerElement(el)
}

export function resetAgentSpinnerClockForTesting(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  elements.clear()
  if (teardownGlobalListeners !== null) {
    teardownGlobalListeners()
    teardownGlobalListeners = null
  }
  step = 0
}
