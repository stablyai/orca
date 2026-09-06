import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { createTuiWheelProbe, type TuiWheelProbeTerminal } from './preview-terminal-tui-wheel-probe'
import { isReplayedWheelEvent } from '@/lib/pane-manager/pane-terminal-mouse-wheel'
import type { SessionGridWheelTarget } from '../../../../shared/session-grid-types'

/** Whoever owns a wheel gesture keeps it this long past its last event; only a pause moves the wheel to the other scroller. */
export const WHEEL_GESTURE_LATCH_MS = 300

const TERMINAL_WHEEL_REPLAY_PROPERTY = '__orcaPreviewTerminalWheelReplay'

/** A Shift+wheel re-dispatched to xterm without Shift; every surface above the terminal lets it through. */
export function isTerminalWheelReplay(event: WheelEvent): boolean {
  return (
    (event as WheelEvent & { [TERMINAL_WHEEL_REPLAY_PROPERTY]?: true })[
      TERMINAL_WHEEL_REPLAY_PROPERTY
    ] === true
  )
}

/**
 * Why a clone: xterm cannot take the shifted event itself — off macOS its
 * viewport turns Shift+wheel into a horizontal scroll, and a mouse report
 * would carry the modifier to the TUI.
 */
function replayWheelToTerminal(event: WheelEvent): void {
  const replay = new WheelEvent(event.type, {
    bubbles: true,
    cancelable: true,
    composed: event.composed,
    view: event.view,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode
  })
  Object.defineProperty(replay, TERMINAL_WHEEL_REPLAY_PROPERTY, { value: true })
  event.target?.dispatchEvent(replay)
}

type WheelHandoffTerminal = Pick<Terminal, 'buffer' | 'modes'> & TuiWheelProbeTerminal

/** Installs the handoff only while a surface opts in; a lone dialog leaves the wheel to xterm, as on any pane. */
export function usePreviewWheelOverflow(args: {
  containerRef: React.RefObject<HTMLElement | null>
  terminalRef: React.RefObject<WheelHandoffTerminal | null>
  onWheelOverflow: ((event: WheelEvent) => void) | undefined
  wheelTarget?: SessionGridWheelTarget
}): void {
  const { containerRef, terminalRef, onWheelOverflow, wheelTarget = 'auto' } = args
  const callbackRef = useRef(onWheelOverflow)
  const wheelTargetRef = useRef(wheelTarget)
  useLayoutEffect(() => {
    callbackRef.current = onWheelOverflow
    wheelTargetRef.current = wheelTarget
  }, [onWheelOverflow, wheelTarget])
  const enabled = onWheelOverflow !== undefined
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) {
      return
    }
    return installPreviewWheelHandoff({
      container,
      getTerminal: () => terminalRef.current,
      onWheelOverflow: (event) => callbackRef.current?.(event),
      getWheelTarget: () => wheelTargetRef.current
    })
  }, [containerRef, terminalRef, enabled])
}

/** Who a gesture over a mouse-tracking TUI belongs to; 'probing' while the screen is being watched for a reaction. */
type TuiGestureOwner = 'none' | 'probing' | 'tui' | 'grid'

/**
 * Hands the wheel to `onWheelOverflow` once the terminal cannot use it.
 *
 * With no mouse tracking the terminal's own scrollback is the only scroll a
 * card has, and its ends are known: at an end the wheel leaves. A gesture that
 * was scrolling the terminal holds at the end until it pauses, so an overshoot
 * does not flip the surface.
 *
 * A mouse-tracking TUI gets its wheel reports through xterm and never says
 * whether it used them, so the first report of a gesture is a probe: if the
 * screen moves, the gesture is the TUI's; if it does not, or the screen was
 * already moving, the gesture is the surface's. Either way it stays put until
 * the gesture pauses.
 *
 * That is the 'auto' wheel target. Under 'terminal' the wheel is xterm's
 * outright; under 'grid' only Shift+wheel reaches the terminal, and it is
 * replayed to xterm without the modifier. The surface takes the rest before
 * it gets here.
 */
export function installPreviewWheelHandoff(args: {
  container: HTMLElement
  getTerminal: () => WheelHandoffTerminal | null
  onWheelOverflow: (event: WheelEvent) => void
  getWheelTarget?: () => SessionGridWheelTarget
  now?: () => number
}): () => void {
  const now = args.now ?? ((): number => Date.now())
  const probe = createTuiWheelProbe({ getTerminal: args.getTerminal, now })
  let lastOwnedAt = Number.NEGATIVE_INFINITY
  let tuiOwner: TuiGestureOwner = 'none'
  let tuiGestureAt = Number.NEGATIVE_INFINITY
  let pendingWheel: { event: WheelEvent; deltaY: number } | null = null

  const handOff = (e: WheelEvent): void => {
    // Why stopPropagation: xterm must not act on a wheel that left — in the alt
    // buffer it would send arrow keys, under mouse tracking a wheel report.
    e.stopPropagation()
    args.onWheelOverflow(e)
  }

  const handleTuiWheel = (e: WheelEvent, at: number): void => {
    if (
      at - tuiGestureAt >= WHEEL_GESTURE_LATCH_MS ||
      (pendingWheel && pendingWheel.event.deltaMode !== e.deltaMode)
    ) {
      probe.cancel()
      pendingWheel = null
      tuiOwner = 'none'
    }
    tuiGestureAt = at
    switch (tuiOwner) {
      case 'tui':
        return
      case 'probing':
        if (pendingWheel) {
          pendingWheel.deltaY += e.deltaY
        }
        return
      case 'grid':
        handOff(e)
        return
      case 'none':
        if (probe.isBusy()) {
          tuiOwner = 'grid'
          handOff(e)
          return
        }
        tuiOwner = 'probing'
        pendingWheel = { event: e, deltaY: e.deltaY }
        const terminal = args.getTerminal()
        probe.start((verdict) => {
          if (tuiOwner === 'probing') {
            tuiOwner = verdict
            const pending = pendingWheel
            pendingWheel = null
            if (
              verdict === 'grid' &&
              pending?.deltaY &&
              (args.getWheelTarget?.() ?? 'auto') === 'auto' &&
              args.getTerminal() === terminal
            ) {
              // The gesture may end before the probe; retain its movement without retaining every event.
              const overflow = new WheelEvent('wheel', {
                deltaY: pending.deltaY,
                deltaMode: pending.event.deltaMode,
                cancelable: true
              })
              Object.defineProperty(overflow, 'wheelDeltaY', {
                value: (pending.event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
              })
              handOff(overflow)
            }
          }
        })
    }
  }

  const handleWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) {
      return
    }
    if (isTerminalWheelReplay(e) || isReplayedWheelEvent(e)) {
      return
    }
    const wheelTarget = args.getWheelTarget?.() ?? 'auto'
    if (wheelTarget === 'terminal') {
      return
    }
    if (wheelTarget === 'grid') {
      if (e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        replayWheelToTerminal(e)
      }
      return
    }
    // Shift bypasses the terminal entirely; the surrounding surface owns it.
    if (e.shiftKey) {
      return
    }
    const terminal = args.getTerminal()
    if (!terminal) {
      return
    }
    const at = now()
    if (terminal.modes.mouseTrackingMode !== 'none') {
      handleTuiWheel(e, at)
      return
    }
    const buffer = terminal.buffer.active
    const canScrollUp = buffer.viewportY > 0
    const canScrollDown = buffer.viewportY < buffer.baseY
    if ((e.deltaY < 0 && canScrollUp) || (e.deltaY > 0 && canScrollDown)) {
      lastOwnedAt = at
      return
    }
    if (at - lastOwnedAt < WHEEL_GESTURE_LATCH_MS) {
      lastOwnedAt = at
      e.preventDefault()
      e.stopPropagation()
      return
    }
    handOff(e)
  }

  // Capture phase: xterm's own listener stops propagation, so a bubble listener would never see the overflow.
  args.container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => {
    args.container.removeEventListener('wheel', handleWheel, { capture: true })
    probe.dispose()
    pendingWheel = null
  }
}
