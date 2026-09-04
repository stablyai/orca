import type { SessionGridWheelTarget } from '../../../../shared/session-grid-types'
import { isReplayedWheelEvent } from '@/lib/pane-manager/pane-terminal-mouse-wheel'
import {
  isTerminalWheelReplay,
  replayWheelToTerminal
} from '@/lib/pane-manager/terminal-wheel-replay'
import {
  getSessionGridWheelDelta,
  isDiscreteWheelEvent,
  WHEEL_GESTURE_GAP_MS
} from './session-grid-wheel-gesture'
import { hasSessionGridTerminalFocus } from './session-grid-terminal-focus'

type WheelOwner = HTMLElement | null

export function installSessionGridWheelRouting(args: {
  container: HTMLElement
  getWheelTarget: () => SessionGridWheelTarget
  onGridWheel: (event: WheelEvent, deltaY: number) => void
  onGestureReset: () => void
}): () => void {
  const { container } = args
  const document = container.ownerDocument
  const window = document.defaultView
  let owner: WheelOwner | undefined
  let lastAt = Number.NEGATIVE_INFINITY
  let lastMode: SessionGridWheelTarget | undefined
  let lastShift = false
  let focusRevision = 0
  let lastFocusRevision = 0
  let lastActive: Element | null = null
  let lastWindowFocus = false
  let pointerMovedZone = false
  let pointer: { x: number; y: number; zone: WheelOwner } | undefined

  const terminalAt = (target: EventTarget | null): WheelOwner => {
    const element = target as Element | null
    const terminal = element?.closest?.<HTMLElement>('.xterm') ?? null
    return terminal && container.contains(terminal) ? terminal : null
  }
  const notePointer = (event: MouseEvent, zone: WheelOwner): void => {
    if (
      pointer &&
      (pointer.x !== event.clientX || pointer.y !== event.clientY) &&
      pointer.zone !== zone
    ) {
      pointerMovedZone = true
    }
    pointer = { x: event.clientX, y: event.clientY, zone }
  }
  const onPointerMove = (event: PointerEvent): void => notePointer(event, terminalAt(event.target))
  const onFocusChange = (): void => {
    focusRevision++
  }
  const cancel = (event: WheelEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onWheel = (event: WheelEvent): void => {
    if (isTerminalWheelReplay(event) || isReplayedWheelEvent(event)) {
      return
    }
    const deltaY = getSessionGridWheelDelta(event)
    if (deltaY === 0) {
      return
    }
    // Browser wheel transactions can retain an old event target after the pointer moves.
    const hit = event.isTrusted
      ? (document.elementFromPoint(event.clientX, event.clientY) ?? event.target)
      : event.target
    const zone = terminalAt(hit)
    notePointer(event, zone)
    const mode = args.getWheelTarget()
    const now = Date.now()
    const windowFocused = document.hasFocus()
    const explicitChange =
      pointerMovedZone || mode !== lastMode || Boolean(event.shiftKey) !== lastShift
    const newGesture = owner === undefined || now - lastAt > WHEEL_GESTURE_GAP_MS || explicitChange
    const fresh = newGesture || isDiscreteWheelEvent(event)
    const focusChanged =
      focusRevision !== lastFocusRevision ||
      document.activeElement !== lastActive ||
      windowFocused !== lastWindowFocus
    lastAt = now
    lastMode = mode
    lastShift = Boolean(event.shiftKey)
    lastActive = document.activeElement
    lastWindowFocus = windowFocused
    lastFocusRevision = focusRevision
    pointerMovedZone = false

    // A removed surface cannot donate its remaining momentum to the next card.
    if (!fresh && owner && !container.contains(owner)) {
      cancel(event)
      return
    }
    if (fresh || focusChanged) {
      const terminalOwns =
        mode === 'terminal' ||
        (mode === 'focus' && zone !== null && hasSessionGridTerminalFocus(zone))
      const nextOwner = zone && terminalOwns !== Boolean(event.shiftKey) ? zone : null
      if (newGesture || focusChanged || nextOwner !== owner) {
        args.onGestureReset()
      }
      owner = nextOwner
    }
    if (!owner) {
      cancel(event)
      args.onGridWheel(event, deltaY)
      return
    }
    if (event.shiftKey || terminalAt(event.target) !== owner) {
      cancel(event)
      replayWheelToTerminal(event, deltaY, owner.querySelector('.xterm-screen') ?? owner)
    }
  }

  const containTerminalWheel = (event: WheelEvent): void => {
    // Native xterm scrolling ignores pre-cancelled events; contain overflow only after delivery.
    if (terminalAt(event.target)) {
      event.preventDefault()
    }
  }
  container.addEventListener('wheel', onWheel, { capture: true, passive: false })
  container.addEventListener('wheel', containTerminalWheel, { passive: false })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('focusin', onFocusChange)
  document.addEventListener('focusout', onFocusChange)
  window?.addEventListener('focus', onFocusChange)
  window?.addEventListener('blur', onFocusChange)
  return () => {
    owner = undefined
    container.removeEventListener('wheel', onWheel, { capture: true })
    container.removeEventListener('wheel', containTerminalWheel)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('focusin', onFocusChange)
    document.removeEventListener('focusout', onFocusChange)
    window?.removeEventListener('focus', onFocusChange)
    window?.removeEventListener('blur', onFocusChange)
  }
}
