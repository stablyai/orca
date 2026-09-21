/** Shared row semantics for the list tables (automations, artifacts, …). */

/** True when a portaled Radix menu click re-bubbles through a row's React tree. */
export function isPortaledRowMenuClick(event: {
  target: EventTarget
  currentTarget: EventTarget
}): boolean {
  const target = event.target
  return target instanceof Node && event.currentTarget instanceof Node
    ? !event.currentTarget.contains(target)
    : false
}

/**
 * True when Enter/Space landed on the row itself. Keys pressed on a nested
 * control (the actions trigger) must stay with that control — preventDefault
 * here would swallow its native activation.
 */
export function isRowActivationKey(event: {
  key: string
  target: EventTarget
  currentTarget: EventTarget
}): boolean {
  if (event.target !== event.currentTarget) {
    return false
  }
  return event.key === 'Enter' || event.key === ' '
}
