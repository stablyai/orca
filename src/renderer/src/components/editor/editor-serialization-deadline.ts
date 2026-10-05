type SerializationTimerRef = { current: number | null }
const deadlines = new WeakMap<SerializationTimerRef, { timer: number; deadline: number }>()

/** Idle serialization stays cheap, while continuous input still materializes a draft. */
export function scheduleEditorSerialization(
  timerRef: SerializationTimerRef,
  serialize: () => void,
  delayMs: number,
  maxWaitMs = 500
): void {
  const previous = deadlines.get(timerRef)
  const deadline = previous?.timer === timerRef.current ? previous.deadline : Date.now() + maxWaitMs
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current)
  }
  const timer = window.setTimeout(
    () => {
      timerRef.current = null
      deadlines.delete(timerRef)
      serialize()
    },
    Math.max(0, Math.min(delayMs, deadline - Date.now()))
  )
  timerRef.current = timer
  deadlines.set(timerRef, { timer, deadline })
}
