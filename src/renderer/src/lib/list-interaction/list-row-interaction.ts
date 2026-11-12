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

/** Handle only row-level Enter/Space; nested controls need native activation and must not inherit preventDefault. */
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
