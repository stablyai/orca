import type { PointerEvent as ReactPointerEvent } from 'react'
import type {
  Activators,
  DistanceMeasurement,
  PointerActivationConstraint,
  PointerSensorOptions,
  SensorInstance,
  SensorProps
} from '@dnd-kit/core'

type PointerCoordinates = { x: number; y: number }

const DEFAULT_COORDINATES: PointerCoordinates = { x: 0, y: 0 }
const TAB_DRAG_EARLY_MOVE_CONFIRMATION_MS = 50
const TAB_DRAG_CONFIRMED_DISTANCE_SAMPLE_COUNT = 2

type ListenerEntry = {
  eventName: string
  handler: EventListener
  options?: AddEventListenerOptions | boolean
  target: EventTarget
}

class ListenerBag {
  private readonly listeners: ListenerEntry[] = []

  add<T extends Event>(
    target: EventTarget | null,
    eventName: string,
    handler: (event: T) => void,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (!target) {
      return
    }
    const listener = handler as EventListener
    target.addEventListener(eventName, listener, options)
    this.listeners.push({ eventName, handler: listener, options, target })
  }

  removeAll = (): void => {
    for (const { eventName, handler, options, target } of this.listeners) {
      target.removeEventListener(eventName, handler, options)
    }
    this.listeners.length = 0
  }
}

function isDistanceConstraint(
  constraint: PointerActivationConstraint
): constraint is Extract<PointerActivationConstraint, { distance: DistanceMeasurement }> {
  return 'distance' in constraint
}

function isDelayConstraint(
  constraint: PointerActivationConstraint
): constraint is Extract<PointerActivationConstraint, { delay: number }> {
  return 'delay' in constraint
}

function getOwnerDocument(target: EventTarget | null): Document {
  if (target instanceof Document) {
    return target
  }
  if (target instanceof Node) {
    return target.ownerDocument ?? document
  }
  return document
}

function getPointerCoordinates(event: Event): PointerCoordinates | null {
  if ('clientX' in event && 'clientY' in event) {
    const pointerEvent = event as PointerEvent
    return { x: pointerEvent.clientX, y: pointerEvent.clientY }
  }
  return null
}

function subtractCoordinates(
  start: PointerCoordinates,
  current: PointerCoordinates
): PointerCoordinates {
  return {
    x: start.x - current.x,
    y: start.y - current.y
  }
}

function hasExceededDistance(delta: PointerCoordinates, measurement: DistanceMeasurement): boolean {
  const dx = Math.abs(delta.x)
  const dy = Math.abs(delta.y)

  if (typeof measurement === 'number') {
    return Math.hypot(dx, dy) > measurement
  }
  if ('x' in measurement && 'y' in measurement) {
    return dx > measurement.x && dy > measurement.y
  }
  if ('x' in measurement) {
    return dx > measurement.x
  }
  if ('y' in measurement) {
    return dy > measurement.y
  }
  return false
}

export function shouldActivateTabDragFromDistanceSample({
  elapsedMs,
  overThresholdSampleCount
}: {
  elapsedMs: number
  overThresholdSampleCount: number
}): boolean {
  // Why: one immediate over-threshold sample can be stale/coalesced after
  // window focus; a second sample or a short grace period confirms real motion.
  return (
    elapsedMs >= TAB_DRAG_EARLY_MOVE_CONFIRMATION_MS ||
    overThresholdSampleCount >= TAB_DRAG_CONFIRMED_DISTANCE_SAMPLE_COUNT
  )
}

export class TabDragPointerSensor implements SensorInstance {
  static activators: Activators<PointerSensorOptions> = [
    {
      eventName: 'onPointerDown',
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions
      ): boolean => {
        if (!event.isPrimary || event.button !== 0) {
          return false
        }
        onActivation?.({ event })
        return true
      }
    }
  ]

  autoScrollEnabled = true

  private activated = false
  private readonly document: Document
  private readonly initialCoordinates: PointerCoordinates
  private readonly pointerDownTime = performance.now()
  private readonly props: SensorProps<PointerSensorOptions>
  private readonly documentListeners = new ListenerBag()
  private readonly pointerListeners = new ListenerBag()
  private readonly windowListeners = new ListenerBag()
  private overThresholdSampleCount = 0
  private timeoutId: number | null = null

  constructor(props: SensorProps<PointerSensorOptions>) {
    this.props = props
    this.document = getOwnerDocument(props.event.target)
    this.initialCoordinates = getPointerCoordinates(props.event) ?? DEFAULT_COORDINATES
    this.handleStart = this.handleStart.bind(this)
    this.handleMove = this.handleMove.bind(this)
    this.handleEnd = this.handleEnd.bind(this)
    this.handleCancel = this.handleCancel.bind(this)
    this.handleKeydown = this.handleKeydown.bind(this)
    this.removeTextSelection = this.removeTextSelection.bind(this)
    this.attach()
  }

  private attach(): void {
    const win = this.document.defaultView
    const { activationConstraint, bypassActivationConstraint } = this.props.options

    this.pointerListeners.add(this.document, 'pointermove', this.handleMove, { passive: false })
    this.pointerListeners.add(this.document, 'pointerup', this.handleEnd)
    this.pointerListeners.add(this.document, 'pointercancel', this.handleCancel)
    this.windowListeners.add(win, 'resize', this.handleCancel)
    this.windowListeners.add(win, 'dragstart', preventDefault)
    this.windowListeners.add(win, 'visibilitychange', this.handleCancel)
    this.windowListeners.add(win, 'contextmenu', preventDefault)
    this.windowListeners.add(win, 'focus', this.handleCancel)
    this.documentListeners.add(this.document, 'keydown', this.handleKeydown)

    if (!activationConstraint) {
      this.handleStart()
      return
    }
    if (
      bypassActivationConstraint?.({
        activeNode: this.props.activeNode,
        event: this.props.event,
        options: this.props.options
      })
    ) {
      this.handleStart()
      return
    }
    if (isDelayConstraint(activationConstraint)) {
      this.timeoutId = window.setTimeout(this.handleStart, activationConstraint.delay)
      this.handlePending(activationConstraint)
      return
    }
    this.handlePending(activationConstraint)
  }

  private detach(): void {
    this.pointerListeners.removeAll()
    this.windowListeners.removeAll()
    window.setTimeout(this.documentListeners.removeAll, 50)
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }

  private handlePending(
    constraint: PointerActivationConstraint,
    offset?: PointerCoordinates | undefined
  ): void {
    this.props.onPending(this.props.active, constraint, this.initialCoordinates, offset)
  }

  private handleStart(): void {
    if (this.activated) {
      return
    }
    this.activated = true
    this.documentListeners.add(this.document, 'click', stopPropagation, { capture: true })
    this.removeTextSelection()
    this.documentListeners.add(this.document, 'selectionchange', this.removeTextSelection)
    this.props.onStart(this.initialCoordinates)
  }

  private handleMove(event: PointerEvent): void {
    const coordinates = getPointerCoordinates(event)
    const { activationConstraint } = this.props.options
    if (!coordinates) {
      return
    }
    const delta = subtractCoordinates(this.initialCoordinates, coordinates)

    if (!this.activated && activationConstraint) {
      if (isDistanceConstraint(activationConstraint)) {
        if (
          activationConstraint.tolerance != null &&
          hasExceededDistance(delta, activationConstraint.tolerance)
        ) {
          this.handleCancel()
          return
        }
        if (hasExceededDistance(delta, activationConstraint.distance)) {
          this.overThresholdSampleCount += 1
          if (
            shouldActivateTabDragFromDistanceSample({
              elapsedMs: performance.now() - this.pointerDownTime,
              overThresholdSampleCount: this.overThresholdSampleCount
            })
          ) {
            this.handleStart()
            return
          }
        } else {
          this.overThresholdSampleCount = 0
        }
      }
      if (
        isDelayConstraint(activationConstraint) &&
        hasExceededDistance(delta, activationConstraint.tolerance)
      ) {
        this.handleCancel()
        return
      }
      this.handlePending(activationConstraint, delta)
      return
    }

    if (event.cancelable) {
      event.preventDefault()
    }
    this.props.onMove(coordinates)
  }

  private handleEnd(): void {
    this.detach()
    if (!this.activated) {
      this.props.onAbort(this.props.active)
    }
    this.props.onEnd()
  }

  private handleCancel(): void {
    this.detach()
    if (!this.activated) {
      this.props.onAbort(this.props.active)
    }
    this.props.onCancel()
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.code === 'Escape') {
      this.handleCancel()
    }
  }

  private removeTextSelection(): void {
    this.document.getSelection()?.removeAllRanges()
  }
}

function preventDefault(event: Event): void {
  event.preventDefault()
}

function stopPropagation(event: Event): void {
  event.stopPropagation()
}
